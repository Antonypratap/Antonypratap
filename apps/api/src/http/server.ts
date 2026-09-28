import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
} from 'fastify';
import multipart from '@fastify/multipart';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiAnswerBodySchema,
  ApiAuditEntrySchema,
  ApiDemoScenarioSchema,
  ApiErpSchema,
  ApiImportSchema,
  ApiInboxSchema,
  ApiInvoiceDetailSchema,
  ApiQuestionSchema,
  MAX_UPLOAD_BYTES,
  formatInr,
  formatQty,
  milliQty,
  paise,
} from '@veyra/shared';
import { stateName } from '@veyra/india-tax';
import {
  CAPABILITY_LABEL,
  ERP_CAPABILITIES,
  describeConnection,
  isErpConnectorError,
} from '@veyra/erp-connector';
import * as t from '../db/schema';
import { InvalidTransitionError } from '../workflow/state-machine';
import { VeyraError, uploadLimitText, type Veyra } from '../workflow/veyra';
import { DEMO_SCENARIOS, startScenario } from '../demo/scenarios';
import { Presenter } from './present';
import { isStorageError } from '../storage';
import { BusinessImports } from '../imports/service';
import { templateFiles, templateWorkbook } from '../imports/templates';
import { MAX_IMPORT_FILES } from '../imports/validate';
import type { Environment } from '../config';
import { ulid } from '../ids';
import { pino, type Logger } from 'pino';
import { RateLimiter, bucketOf, type RateBucket } from './rate-limit';
import type { ReadinessReport } from './health';
import {
  auditTable,
  businessRecordsXlsx,
  decisionsTable,
  invoicesTable,
  tableCsv,
  tableXlsx,
} from '../exports/service';

export interface ServerOptions {
  veyra: Veyra;
  /**
   * Dev only: wipe Veyra's data and reset the ERP to the DEMO.md seed, or to an empty business
   * (company only) to try importing business records. Never registered in production.
   */
  resetDemo?: (erp: 'demo' | 'empty') => Promise<void>;
  /** Phase 6: which deployment this is. Dev and demo routes never exist in production. */
  environment?: Environment;
  /** Structured logger (one line per request). Absent: no request logs. */
  log?: Logger;
  limits?: { maxUploadBytes: number; maxJsonBodyBytes: number };
  rateLimits?: Record<RateBucket, number>;
  /** Proxy hops trusted for the client address. */
  trustProxy?: number;
  /** Readiness of the instance's dependencies (GET /api/v1/health/ready). */
  readiness?: () => Promise<ReadinessReport>;
}

/**
 * An incoming `x-request-id` is reused only from a trusted reverse proxy (VEYRA_TRUST_PROXY > 0)
 * and only when it looks like an id; otherwise Veyra generates one. Never arbitrary text in logs.
 */
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

const Id = z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });

const STATUS: Record<VeyraError['code'], number> = {
  NOT_FOUND: 404,
  DUPLICATE_UPLOAD: 409,
  INVALID_STATE: 409,
  INVALID_INPUT: 422,
  UNSUPPORTED_FILE: 415,
  NOT_DESIGNATED_USER: 403,
};

/**
 * The REST API (/api/v1). Every request body is validated with Zod; every response is validated
 * against the shared contract before it is sent. The designated user is decided server-side:
 * V1 has one user and no login (authentication is out of scope for this slice).
 */
export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { veyra } = options;
  const environment = options.environment ?? 'development';
  const present = new Presenter(veyra);
  const maxUploadBytes = Math.min(
    options.limits?.maxUploadBytes ?? MAX_UPLOAD_BYTES,
    MAX_UPLOAD_BYTES,
  );
  const hops = options.trustProxy ?? 0;
  const app = Fastify({
    loggerInstance: (options.log ?? pino({ level: 'silent' })) as FastifyBaseLogger,
    bodyLimit: options.limits?.maxJsonBodyBytes ?? 1024 * 1024,
    // Trust exactly the configured number of proxy hops for the client address (rate limits).
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
    // Our own per-request line (below) replaces Fastify's two.
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: (req) => {
      const given = hops > 0 ? req.headers['x-request-id'] : undefined;
      return typeof given === 'string' && REQUEST_ID.test(given) ? given : ulid();
    },
  });
  // Invoice uploads take one file; business-record imports up to 8 (each ≤ 5 MB, checked).
  await app.register(multipart, {
    limits: {
      fileSize: maxUploadBytes,
      files: MAX_IMPORT_FILES,
      fields: 0,
      parts: MAX_IMPORT_FILES,
    },
  });
  const imports = new BusinessImports(veyra);
  const limiter = new RateLimiter(options.rateLimits ?? { upload: 60, processing: 120, dev: 60 });

  const send = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => schema.parse(value);
  const error = (
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    requestId?: string,
  ) => ({
    error: { code, message, details, ...(requestId ? { requestId } : {}) },
  });

  // Every response carries its request id, for support and log correlation.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    const bucket = bucketOf(req.method, req.routeOptions.url);
    if (!bucket) return;
    const retryAfter = limiter.hit(bucket, req.ip);
    if (retryAfter !== null) {
      reply.header('retry-after', String(retryAfter));
      return reply
        .status(429)
        .send(
          error(
            'RATE_LIMITED',
            'Too many requests. Wait a moment and try again.',
            { retryAfterSeconds: retryAfter },
            req.id,
          ),
        );
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? null;
    const line = {
      method: req.method,
      route,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    };
    // Health checks are polled constantly: debug only.
    if (route?.startsWith('/api/v1/health')) req.log.debug(line, 'request');
    else if (reply.statusCode >= 500) req.log.error(line, 'request');
    else req.log.info(line, 'request');
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send(error('NOT_FOUND', 'There is no such endpoint.', {}, req.id)),
  );

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    const e = (code: string, message: string, details: Record<string, unknown> = {}) =>
      error(code, message, details, req.id);
    if (err instanceof VeyraError)
      return reply.status(STATUS[err.code]).send(e(err.code, err.message, err.details));
    if (err instanceof InvalidTransitionError)
      return reply.status(409).send(e(err.code, err.message));
    if (err instanceof z.ZodError)
      return reply.status(422).send(
        e('VALIDATION', 'The request is not valid.', {
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      );
    if ('code' in err && err.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply
        .status(413)
        .send(e('TOO_LARGE', `Files up to ${uploadLimitText(maxUploadBytes)} are accepted.`));
    // ERP failures carry only a stable code and a safe message: never the underlying error.
    if (isErpConnectorError(err))
      return err.retryable
        ? reply.status(503).send(e('ERP_UNAVAILABLE', 'Your ERP could not be reached.'))
        : reply.status(502).send(e(`ERP_${err.code}`, err.userMessage));
    if (isStorageError(err)) {
      req.log.error({ errorCode: err.code }, 'document storage error');
      return err.code === 'STORAGE_NOT_FOUND' || err.code === 'STORAGE_INVALID_KEY'
        ? reply.status(404).send(e('NOT_FOUND', 'The document file is not available.'))
        : reply
            .status(err.retryable ? 503 : 500)
            .send(e(err.code, 'Documents cannot be read right now.'));
    }
    // Fastify's own client errors (malformed JSON, body too large, wrong content type, …): a
    // stable code and a fixed message, never the parser's text.
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      const [code, message] =
        status === 413
          ? ['TOO_LARGE', 'The request is too large.']
          : status === 415
            ? ['UNSUPPORTED_MEDIA_TYPE', 'This content type is not accepted.']
            : status === 406 || status === 429
              ? ['BAD_REQUEST', 'The request could not be handled.']
              : ['BAD_REQUEST', 'The request could not be read.'];
      return reply.status(status).send(e(code, message));
    }
    // Everything else is internal: logged in full server-side, a generic answer to the client.
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(e('INTERNAL', 'Something went wrong.'));
  });

  const user = () => veyra.designatedUserId();

  app.get('/api/v1/health', async () => ({
    ok: true,
    environment,
    demo: Boolean(options.resetDemo) && environment !== 'production',
    erp: veyra.erp.info,
    extractor: { id: veyra.extractor.id, version: veyra.extractor.version },
  }));
  // Liveness: the process is up and serving. No dependency is checked.
  app.get('/api/v1/health/live', async () => ({ status: 'ok' }));
  // Readiness: this instance can do its work (database, storage, worker). 503 when it cannot.
  app.get('/api/v1/health/ready', async (_req, reply) => {
    if (!options.readiness) return { status: 'ready', environment };
    const report = await options.readiness();
    return reply.status(report.status === 'ready' ? 200 : 503).send(report);
  });

  // ── Documents ────────────────────────────────────────────────────────────
  app.post('/api/v1/documents', async (req, reply) => {
    const file = await req.file();
    if (!file) throw new VeyraError('INVALID_INPUT', 'Attach the invoice file.');
    const bytes = await file.toBuffer();
    const created = await veyra.upload({ filename: file.filename, bytes });
    req.log.info(
      { documentId: created.documentId, invoiceId: created.invoiceId },
      'document stored',
    );
    return reply.status(201).send(created);
  });

  app.get('/api/v1/documents', async () =>
    veyra.db
      .select()
      .from(t.documents)
      .innerJoin(t.invoices, eq(t.invoices.documentId, t.documents.id))
      .orderBy(desc(t.documents.uploadedAt))
      .all()
      .map(({ documents: d, invoices: i }) => ({
        id: d.id,
        filename: d.filename,
        mime: d.mime,
        sizeBytes: d.sizeBytes,
        sha256: d.sha256,
        uploadedAt: d.uploadedAt,
        invoiceId: i.id,
        state: i.state,
      })),
  );

  const documentRow = (id: string) => {
    const d = veyra.db.select().from(t.documents).where(eq(t.documents.id, id)).get();
    if (!d) throw new VeyraError('NOT_FOUND', 'Document not found.');
    return d;
  };

  app.get('/api/v1/documents/:id', async (req) => {
    const d = documentRow(Id.parse(req.params).id);
    const inv = veyra.db.select().from(t.invoices).where(eq(t.invoices.documentId, d.id)).get();
    return {
      id: d.id,
      filename: d.filename,
      mime: d.mime,
      sizeBytes: d.sizeBytes,
      sha256: d.sha256,
      uploadedAt: d.uploadedAt,
      invoiceId: inv?.id ?? null,
      state: inv?.state ?? null,
      failureReason: inv?.failureReason ?? null,
      extraction: inv ? latestExtraction(inv.id) : null,
    };
  });

  /** How the document was last read: which extractor, how many pages, which read methods. */
  const latestExtraction = (invoiceId: string) => {
    const x = veyra.db
      .select()
      .from(t.extractions)
      .where(eq(t.extractions.invoiceId, invoiceId))
      .orderBy(desc(t.extractions.createdAt))
      .get();
    if (!x) return null;
    const raw = JSON.parse(x.rawJson) as { pages?: number; warnings?: string[] };
    const methods = veyra.db
      .selectDistinct({ method: t.extractedFields.method })
      .from(t.extractedFields)
      .where(eq(t.extractedFields.extractionId, x.id))
      .all()
      .map((r) => r.method)
      .filter((m): m is string => m !== null)
      .sort();
    return {
      extractor: x.extractorId,
      version: x.extractorVersion,
      pages: raw.pages ?? null,
      methods,
      warnings: raw.warnings ?? [],
      readAt: x.createdAt,
    };
  };

  app.get('/api/v1/documents/:id/file', async (req, reply) => {
    const d = documentRow(Id.parse(req.params).id);
    return reply
      .header('content-type', d.mime)
      .header('content-disposition', `inline; filename="${d.filename.replace(/"/g, '')}"`)
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(await veyra.readDocument(d)));
  });

  // ── Invoices ─────────────────────────────────────────────────────────────
  app.get('/api/v1/invoices', async () => send(ApiInboxSchema, await present.inbox()));

  app.get('/api/v1/invoices/:id', async (req) =>
    send(ApiInvoiceDetailSchema, await present.detail(Id.parse(req.params).id)),
  );

  app.post('/api/v1/invoices/:id/reject', async (req) => {
    const { id } = Id.parse(req.params);
    const { reason } = z
      .object({ reason: z.string().trim().min(1).max(300) })
      .parse(req.body ?? {});
    veyra.reject(id, reason, user());
    return { invoiceId: id, state: veyra.invoiceRow(veyra.db, id).state };
  });

  app.post('/api/v1/invoices/:id/reprocess', async (req) => {
    const { id } = Id.parse(req.params);
    veyra.reprocess(id, user());
    return { invoiceId: id, state: veyra.invoiceRow(veyra.db, id).state };
  });

  // ── Questions ────────────────────────────────────────────────────────────
  app.get('/api/v1/questions', async (req) => {
    const { status } = z
      .object({ status: z.enum(['open', 'answered']).default('open') })
      .parse(req.query ?? {});
    return send(z.array(ApiQuestionSchema), await present.questions(status));
  });

  app.get('/api/v1/questions/:id', async (req) => {
    const q = present.question(Id.parse(req.params).id);
    if (!q) throw new VeyraError('NOT_FOUND', 'Question not found.');
    return send(ApiQuestionSchema, q);
  });

  app.post('/api/v1/questions/:id/answer', async (req) => {
    const { id } = Id.parse(req.params);
    const body = ApiAnswerBodySchema.parse(req.body ?? {});
    veyra.answer(id, { optionId: body.optionId, input: body.input ?? null }, user());
    const q = present.question(id);
    return {
      questionId: id,
      invoiceId: q?.invoiceId ?? null,
      state: q ? veyra.invoiceRow(veyra.db, q.invoiceId).state : null,
    };
  });

  // ── Audit ────────────────────────────────────────────────────────────────
  app.get('/api/v1/audit', async (req) => {
    const { invoiceId, scope } = z
      .object({
        invoiceId: z
          .string()
          .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
          .optional(),
        scope: z.enum(['records']).optional(),
      })
      .parse(req.query ?? {});
    if (scope === 'records') return send(z.array(ApiAuditEntrySchema), present.recordsAudit());
    return send(z.array(ApiAuditEntrySchema), present.audit(invoiceId ?? null));
  });

  // ── ERP (read-only, through ErpConnector) ────────────────────────────────
  const erp = veyra.erp;
  app.get('/api/v1/erp/company', async () => erp.getCompany());
  // Read-only (Phase 4): which business system, whether it is connected, what it can do.
  app.get('/api/v1/erp/connection', async () => {
    const c = await describeConnection(erp);
    return send(ApiErpSchema.connection, {
      type: c.type,
      displayName: c.displayName,
      version: c.version,
      status: c.status,
      company: c.company,
      capabilities: ERP_CAPABILITIES.map((key) => ({
        key,
        label: CAPABILITY_LABEL[key],
        supported: c.capabilities.includes(key),
      })),
    });
  });
  app.get('/api/v1/erp/vendors', async () =>
    send(
      ApiErpSchema.vendors,
      (await erp.listVendors()).map((v) => ({
        code: v.code,
        name: v.name,
        gstin: v.gstin,
        state: stateName(v.stateCode) ?? v.stateCode,
        status: v.status,
        origin: v.origin,
      })),
    ),
  );
  app.get('/api/v1/erp/items', async () =>
    send(
      ApiErpSchema.items,
      (await erp.listItems()).map((i) => ({
        code: i.code,
        name: i.name,
        hsnSac: i.hsnSac,
        uom: i.uom,
        gstRateBp: i.gstRateBp,
        origin: i.origin,
      })),
    ),
  );
  app.get('/api/v1/erp/purchase-orders', async () => {
    const vendors = new Map((await erp.listVendors()).map((v) => [v.id, v.name]));
    const items = new Map((await erp.listItems()).map((i) => [i.id, i]));
    return send(
      ApiErpSchema.purchaseOrders,
      (await erp.listPurchaseOrders()).map((po) => ({
        poNumber: po.poNumber,
        vendor: vendors.get(po.vendorId) ?? po.vendorId,
        poDate: po.poDate,
        lines: po.lines
          .map(
            (l) =>
              `${items.get(l.itemId)?.name ?? l.itemId} × ${formatQty(milliQty(l.qtyMilli))} ${items.get(l.itemId)?.uom ?? ''} @ ${formatInr(paise(l.unitPricePaise))}`,
          )
          .join('; '),
        status: po.status,
        origin: po.origin,
      })),
    );
  });
  app.get('/api/v1/erp/grns', async () => {
    const pos = await erp.listPurchaseOrders();
    const items = new Map((await erp.listItems()).map((i) => [i.id, i]));
    const poLine = new Map(
      pos.flatMap((p) =>
        p.lines.map((l) => [l.id, { po: p.poNumber, uom: items.get(l.itemId)?.uom ?? '' }]),
      ),
    );
    return send(
      ApiErpSchema.grns,
      (await erp.listGrns()).map((g) => ({
        grnNumber: g.grnNumber,
        poNumber: pos.find((p) => p.id === g.poId)?.poNumber ?? g.poId,
        grnDate: g.grnDate,
        accepted: g.lines
          .map(
            (l) =>
              `${formatQty(milliQty(l.acceptedQtyMilli))} ${poLine.get(l.poLineId)?.uom ?? ''}`,
          )
          .join('; '),
        origin: g.origin,
      })),
    );
  });
  app.get('/api/v1/erp/purchase-invoices', async () => {
    const vendors = new Map((await erp.listVendors()).map((v) => [v.id, v.name]));
    const orders = new Map((await erp.listPurchaseOrders()).map((o) => [o.id, o.poNumber]));
    return send(
      ApiErpSchema.purchaseInvoices,
      (await erp.listPurchaseInvoices()).map((p) => ({
        id: p.id,
        vendorInvoiceNo: p.vendorInvoiceNo,
        vendor: vendors.get(p.vendorId) ?? p.vendorId,
        invoiceDate: p.invoiceDate,
        totalPaise: p.totalPaise,
        status: p.status,
        poNumber: orders.get(p.poId) ?? null,
        lines: p.lines.length,
      })),
    );
  });

  // ── Business records: templates, import, export (Phase 3C) ──────────────
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const download = (reply: FastifyReply, name: string, type: string, body: Buffer) =>
    reply
      .header('content-type', type)
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('x-content-type-options', 'nosniff')
      .send(body);

  app.get('/api/v1/imports/templates', async () =>
    templateFiles().map((f) => ({
      ...f,
      url: `/api/v1/imports/templates/${encodeURIComponent(f.file)}`,
    })),
  );
  app.get('/api/v1/imports/templates/:file', async (req, reply) => {
    const { file } = z.object({ file: z.string().max(80) }).parse(req.params);
    const body = templateWorkbook(file);
    if (!body) throw new VeyraError('NOT_FOUND', 'No such template.');
    return download(reply, file, XLSX, body);
  });

  app.post('/api/v1/imports', async (req, reply) => {
    const files: { filename: string; bytes: Uint8Array }[] = [];
    for await (const part of req.files())
      files.push({ filename: part.filename, bytes: await part.toBuffer() });
    if (files.length === 0) throw new VeyraError('INVALID_INPUT', 'Attach a file to import.');
    return reply.status(201).send(send(ApiImportSchema, await imports.check(files, user())));
  });
  app.get('/api/v1/imports', async () => send(z.array(ApiImportSchema), imports.list()));
  app.get('/api/v1/imports/:id', async (req) =>
    send(ApiImportSchema, imports.get(Id.parse(req.params).id)),
  );
  app.post('/api/v1/imports/:id/confirm', async (req) =>
    send(ApiImportSchema, await imports.confirm(Id.parse(req.params).id, user())),
  );

  app.get('/api/v1/exports/:name', async (req, reply) => {
    const { name } = z.object({ name: z.string().max(40) }).parse(req.params);
    if (name === 'business-records.xlsx')
      return download(
        reply,
        'Business-records.xlsx',
        XLSX,
        businessRecordsXlsx(await imports.snapshot()),
      );
    const m = /^(invoices|decisions|audit)\.(xlsx|csv)$/.exec(name);
    const kind = m?.[1] as 'invoices' | 'decisions' | 'audit' | undefined;
    if (!kind) throw new VeyraError('NOT_FOUND', 'No such export.');
    const table =
      kind === 'invoices'
        ? await invoicesTable(present)
        : kind === 'decisions'
          ? await decisionsTable(present)
          : await auditTable(present);
    const file = `Veyra-${kind}-${veyra.today()}`;
    return m?.[2] === 'csv'
      ? download(reply, `${file}.csv`, 'text/csv; charset=utf-8', tableCsv(table))
      : download(reply, `${file}.xlsx`, XLSX, tableXlsx(table));
  });

  // ── Dev ──────────────────────────────────────────────────────────────────
  // Never in production, whatever else is configured (enforced here, not by the UI). Staging may
  // run with NODE_ENV=production; the Veyra environment decides.
  if (options.resetDemo && environment !== 'production') {
    const reset = options.resetDemo;
    app.post('/api/v1/dev/reset', async (req) => {
      const { erp: mode } = z
        .object({ erp: z.enum(['demo', 'empty']).default('demo') })
        .parse(req.body ?? {});
      await reset(mode);
      return { ok: true, erp: mode };
    });
    // Demo scenarios (Phase 3E): each uploads one synthetic invoice through the normal path.
    app.get('/api/v1/dev/scenarios', async () =>
      send(
        z.array(ApiDemoScenarioSchema),
        DEMO_SCENARIOS.map(({ key, title, story, expect }) => ({ key, title, story, expect })),
      ),
    );
    app.post('/api/v1/dev/scenarios/:key', async (req, reply) => {
      const { key } = z.object({ key: z.string() }).parse(req.params);
      const started = await startScenario(veyra, key);
      if (!started) throw new VeyraError('NOT_FOUND', 'There is no such demo scenario.');
      return reply.status(started.existing ? 200 : 201).send(started);
    });
  }

  return app;
}
