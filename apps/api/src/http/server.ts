import { readFileSync } from 'node:fs';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiAnswerBodySchema,
  ApiAuditEntrySchema,
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
import { isErpConnectorError } from '@veyra/erp-connector';
import * as t from '../db/schema';
import { InvalidTransitionError } from '../workflow/state-machine';
import { VeyraError, type Veyra } from '../workflow/veyra';
import { Presenter } from './present';
import { BusinessImports } from '../imports/service';
import { templateFiles, templateWorkbook } from '../imports/templates';
import { MAX_IMPORT_FILES } from '../imports/validate';
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
  logger?: boolean;
}

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
  const present = new Presenter(veyra);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  // Invoice uploads take one file (≤ 20 MB); business-record imports up to 8 (each ≤ 5 MB, checked).
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_IMPORT_FILES, fields: 0 },
  });
  const imports = new BusinessImports(veyra);

  const send = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => schema.parse(value);
  const error = (code: string, message: string, details: Record<string, unknown> = {}) => ({
    error: { code, message, details },
  });

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof VeyraError)
      return reply.status(STATUS[err.code]).send(error(err.code, err.message, err.details));
    if (err instanceof InvalidTransitionError)
      return reply.status(409).send(error(err.code, err.message));
    if (err instanceof z.ZodError)
      return reply.status(422).send(
        error('VALIDATION', 'The request is not valid.', {
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      );
    if ('code' in err && err.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.status(413).send(error('TOO_LARGE', 'Files up to 20 MB are accepted.'));
    if (isErpConnectorError(err))
      return reply.status(503).send(error('ERP_UNAVAILABLE', 'Your ERP could not be reached.'));
    app.log.error(err);
    return reply.status(500).send(error('INTERNAL', 'Something went wrong.'));
  });

  const user = () => veyra.designatedUserId();

  app.get('/api/v1/health', async () => ({
    ok: true,
    erp: veyra.erp.info,
    extractor: { id: veyra.extractor.id, version: veyra.extractor.version },
  }));

  // ── Documents ────────────────────────────────────────────────────────────
  app.post('/api/v1/documents', async (req, reply) => {
    const file = await req.file();
    if (!file) throw new VeyraError('INVALID_INPUT', 'Attach the invoice file.');
    const bytes = await file.toBuffer();
    const created = veyra.upload({ filename: file.filename, bytes });
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
    };
  });

  app.get('/api/v1/documents/:id/file', async (req, reply) => {
    const d = documentRow(Id.parse(req.params).id);
    return reply
      .header('content-type', d.mime)
      .header('content-disposition', `inline; filename="${d.filename.replace(/"/g, '')}"`)
      .header('x-content-type-options', 'nosniff')
      .send(readFileSync(d.storagePath));
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
    return send(
      ApiErpSchema.purchaseInvoices,
      (await erp.listPurchaseInvoices()).map((p) => ({
        id: p.id,
        vendorInvoiceNo: p.vendorInvoiceNo,
        vendor: vendors.get(p.vendorId) ?? p.vendorId,
        invoiceDate: p.invoiceDate,
        totalPaise: p.totalPaise,
        status: p.status,
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
  if (options.resetDemo && process.env.NODE_ENV !== 'production') {
    const reset = options.resetDemo;
    app.post('/api/v1/dev/reset', async (req) => {
      const { erp: mode } = z
        .object({ erp: z.enum(['demo', 'empty']).default('demo') })
        .parse(req.body ?? {});
      await reset(mode);
      return { ok: true, erp: mode };
    });
  }

  return app;
}
