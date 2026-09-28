import { readFileSync } from 'node:fs';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiAnswerBodySchema,
  ApiAuditEntrySchema,
  ApiErpSchema,
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

export interface ServerOptions {
  veyra: Veyra;
  /** Dev only: wipe both databases and re-seed the demo (never registered in production). */
  resetDemo?: () => Promise<void>;
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
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 } });

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
    const { invoiceId } = z
      .object({
        invoiceId: z
          .string()
          .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
          .optional(),
      })
      .parse(req.query ?? {});
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

  // ── Dev ──────────────────────────────────────────────────────────────────
  if (options.resetDemo && process.env.NODE_ENV !== 'production') {
    const reset = options.resetDemo;
    app.post('/api/v1/dev/reset', async () => {
      await reset();
      return { ok: true };
    });
  }

  return app;
}
