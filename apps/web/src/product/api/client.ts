import { z } from 'zod';
import {
  ApiCapabilitiesSchema,
  type ApiCapabilities,
  ApiAuditEntrySchema,
  ApiDemoScenarioSchema,
  type ApiDemoScenario,
  ApiErpSchema,
  ApiImportSchema,
  type ApiImport,
  ApiInboxSchema,
  ApiInvoiceDetailSchema,
  ApiQuestionSchema,
  type ApiAuditEntry,
  type ApiInbox,
  type ApiInvoiceDetail,
  type ApiQuestion,
} from '@veyra/shared';
import { csrfHeaders, sessionEnded } from '../../access/session';
import { API, API_CREDENTIALS } from '../../api-endpoint';

/**
 * The only way the product talks to Veyrafy: the REST API under /api/v1. Every response is
 * validated against the shared contract. The browser sends what the user chose and typed;
 * the server decides everything else (status, result, ERP records).
 */
const BASE = API.base;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

const UNREACHABLE = 'Veyrafy could not be reached. Check your connection; it will keep trying.';
const GATEWAY = new Set([502, 503, 504]);

export async function request<S extends z.ZodType>(
  schema: S,
  path: string,
  init?: RequestInit,
): Promise<z.output<S>> {
  let res: Response;
  // State-changing requests echo the session's CSRF token (docs/SECURITY.md).
  const unsafe = init?.method !== undefined && init.method !== 'GET';
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: API_CREDENTIALS,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        ...(unsafe ? csrfHeaders() : {}),
      },
    });
  } catch {
    throw new ApiError(0, 'OFFLINE', UNREACHABLE);
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 401) sessionEnded();
  if (!res.ok) {
    const parsed = ErrorBody.safeParse(body);
    // A gateway answering for an API that is down (502/503/504 without a Veyrafy error body): the
    // same as no connection at all.
    if (!parsed.success && GATEWAY.has(res.status))
      throw new ApiError(res.status, 'OFFLINE', UNREACHABLE);
    throw parsed.success
      ? new ApiError(
          res.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details ?? {},
        )
      : new ApiError(res.status, 'HTTP', 'Something went wrong. Please try again.');
  }
  return schema.parse(body);
}

export const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const Created = z.object({ documentId: z.string(), invoiceId: z.string() });
const Moved = z.object({ state: z.string().nullable() }).loose();

/** Goods-receipt records imported from the business's own ERP (its JSON export). */
const ReceiptRecords = z.array(
  z.object({
    id: z.string(),
    grnNo: z.string(),
    grnDate: z.string().nullable(),
    vendorName: z.string(),
    invoiceNo: z.string(),
    lines: z.number(),
    attachment: z.string().nullable(),
    importedAt: z.string(),
  }),
);
export type ReceiptRecordView = z.output<typeof ReceiptRecords>[number];

export const api = {
  /** What this organization may use (Phase 8A): availability and usage, never the plan. */
  capabilities: (): Promise<ApiCapabilities> => request(ApiCapabilitiesSchema, '/capabilities'),
  inbox: (): Promise<ApiInbox> => request(ApiInboxSchema, '/invoices'),
  invoice: (id: string): Promise<ApiInvoiceDetail> =>
    request(ApiInvoiceDetailSchema, `/invoices/${encodeURIComponent(id)}`),
  questions: (status: 'open' | 'answered'): Promise<ApiQuestion[]> =>
    request(z.array(ApiQuestionSchema), `/questions?status=${status}`),
  audit: (invoiceId: string): Promise<ApiAuditEntry[]> =>
    request(z.array(ApiAuditEntrySchema), `/audit?invoiceId=${encodeURIComponent(invoiceId)}`),
  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request(Created, '/documents', { method: 'POST', body: form });
  },
  answer: (questionId: string, optionId: string, input: unknown) =>
    request(
      Moved,
      `/questions/${encodeURIComponent(questionId)}/answer`,
      json({ optionId, input }),
    ),
  reject: (invoiceId: string, reason: string) =>
    request(Moved, `/invoices/${encodeURIComponent(invoiceId)}/reject`, json({ reason })),
  reprocess: (invoiceId: string) =>
    request(Moved, `/invoices/${encodeURIComponent(invoiceId)}/reprocess`, { method: 'POST' }),
  /** A one-question check that the main (AI) reader answers, with the result in plain words. */
  testReader: () =>
    request(
      z.object({
        configured: z.boolean(),
        ok: z.boolean(),
        ms: z.number(),
        plain: z.string(),
        technical: z.string(),
      }),
      '/reader/check',
      { method: 'POST' },
    ),
  /** Demo only. `demo`: the sample business back; `empty`: an ERP with only the company in it. */
  resetDemo: (erp: 'demo' | 'empty' = 'demo') =>
    request(z.object({ ok: z.boolean() }).loose(), '/dev/reset', json({ erp })),
  demo: {
    /** Demo scenarios (demo builds only; the list is empty elsewhere). */
    scenarios: async (): Promise<ApiDemoScenario[]> => {
      // Production has no demo endpoints at all; ask only when the server says the demo is on.
      const health = await request(z.object({ demo: z.boolean().optional() }).loose(), '/health')
        .then((h) => h.demo === true)
        .catch(() => false);
      return health
        ? request(z.array(ApiDemoScenarioSchema), '/dev/scenarios').catch(() => [])
        : [];
    },
    start: (key: string) =>
      request(
        z.object({ invoiceId: z.string(), existing: z.boolean() }),
        `/dev/scenarios/${encodeURIComponent(key)}`,
        { method: 'POST' },
      ),
  },
  recordsAudit: (): Promise<ApiAuditEntry[]> =>
    request(z.array(ApiAuditEntrySchema), '/audit?scope=records'),
  imports: {
    list: (): Promise<ApiImport[]> => request(z.array(ApiImportSchema), '/imports'),
    check: (files: readonly File[]): Promise<ApiImport> => {
      const form = new FormData();
      for (const f of files) form.append('file', f, f.name);
      return request(ApiImportSchema, '/imports', { method: 'POST', body: form });
    },
    confirm: (id: string): Promise<ApiImport> =>
      request(ApiImportSchema, `/imports/${encodeURIComponent(id)}/confirm`, { method: 'POST' }),
  },
  /** Check an invoice against its ERP goods-receipt record again (after the ERP was corrected). */
  recheck: (invoiceId: string) =>
    request(Moved, `/invoices/${encodeURIComponent(invoiceId)}/recheck`, { method: 'POST' }),
  receipts: {
    list: () => request(ReceiptRecords, '/erp/receipt-records'),
    import: (filename: string, content: string) =>
      request(
        z.object({ imported: z.number() }),
        '/erp/receipt-records',
        json({ filename, content }),
      ),
    checkAttached: (id: string) =>
      request(Created, `/erp/receipt-records/${encodeURIComponent(id)}/check`, { method: 'POST' }),
  },
  erp: {
    connection: () => request(ApiErpSchema.connection, '/erp/connection'),
    vendors: () => request(ApiErpSchema.vendors, '/erp/vendors'),
    items: () => request(ApiErpSchema.items, '/erp/items'),
    purchaseOrders: () => request(ApiErpSchema.purchaseOrders, '/erp/purchase-orders'),
    grns: () => request(ApiErpSchema.grns, '/erp/grns'),
    purchaseInvoices: () => request(ApiErpSchema.purchaseInvoices, '/erp/purchase-invoices'),
  },
};

/** How the original document was read: its page count and everything else printed on it. */
const DocumentInfo = z
  .object({
    extraction: z
      .object({
        pages: z.number().int().positive().nullable(),
        otherFields: z
          .array(z.object({ label: z.string(), value: z.string(), page: z.number().nullable() }))
          .optional(),
      })
      .loose()
      .nullable(),
  })
  .loose();
export type DocumentInfo = z.output<typeof DocumentInfo>;
export const documentInfo = (documentId: string): Promise<DocumentInfo> =>
  request(DocumentInfo, `/documents/${encodeURIComponent(documentId)}`);

/** One page of the original, as uploaded (a PDF page drawn as an image; a photo as itself). */
export const documentPageUrl = (documentId: string, page: number): string =>
  `${BASE}/documents/${encodeURIComponent(documentId)}/pages/${page}`;

export const documentUrl = (documentId: string): string =>
  `${BASE}/documents/${encodeURIComponent(documentId)}/file`;

/** Downloadable business-record templates (served by the API, generated on request). */
export const TEMPLATES: readonly { file: string; title: string }[] = [
  { file: 'Veyrafy-Master-Data-Import.xlsx', title: 'All business records (one workbook)' },
  { file: 'Vendors.xlsx', title: 'Vendors' },
  { file: 'Items.xlsx', title: 'Items' },
  { file: 'PurchaseOrders.xlsx', title: 'Purchase orders' },
  { file: 'PurchaseOrderLines.xlsx', title: 'Purchase order lines' },
  { file: 'GoodsReceipts.xlsx', title: 'Goods receipts' },
  { file: 'GoodsReceiptLines.xlsx', title: 'Goods receipt lines' },
];
export const templateUrl = (file: string): string =>
  `${BASE}/imports/templates/${encodeURIComponent(file)}`;
export const exportUrl = (name: string): string => `${BASE}/exports/${name}`;
