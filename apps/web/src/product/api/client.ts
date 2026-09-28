import { z } from 'zod';
import {
  ApiAuditEntrySchema,
  ApiErpSchema,
  ApiInboxSchema,
  ApiInvoiceDetailSchema,
  ApiQuestionSchema,
  type ApiAuditEntry,
  type ApiInbox,
  type ApiInvoiceDetail,
  type ApiQuestion,
} from '@veyra/shared';

/**
 * The only way the product talks to Veyra: the REST API under /api/v1. Every response is
 * validated against the shared contract. The browser sends what the user chose and typed;
 * the server decides everything else (status, result, ERP records).
 */
const BASE = '/api/v1';

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

async function request<S extends z.ZodType>(
  schema: S,
  path: string,
  init?: RequestInit,
): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new ApiError(
      0,
      'OFFLINE',
      'Veyra could not be reached. Is the API running (npm run dev:api)?',
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ErrorBody.safeParse(body);
    throw parsed.success
      ? new ApiError(
          res.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details ?? {},
        )
      : new ApiError(res.status, 'HTTP', `Request failed (${res.status}).`);
  }
  return schema.parse(body);
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const Created = z.object({ documentId: z.string(), invoiceId: z.string() });
const Moved = z.object({ state: z.string().nullable() }).loose();

export const api = {
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
  resetDemo: () => request(z.object({ ok: z.boolean() }), '/dev/reset', { method: 'POST' }),
  erp: {
    vendors: () => request(ApiErpSchema.vendors, '/erp/vendors'),
    items: () => request(ApiErpSchema.items, '/erp/items'),
    purchaseOrders: () => request(ApiErpSchema.purchaseOrders, '/erp/purchase-orders'),
    grns: () => request(ApiErpSchema.grns, '/erp/grns'),
    purchaseInvoices: () => request(ApiErpSchema.purchaseInvoices, '/erp/purchase-invoices'),
  },
};

export const documentUrl = (documentId: string): string =>
  `${BASE}/documents/${encodeURIComponent(documentId)}/file`;
