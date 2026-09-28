import { z } from 'zod';
import { INVOICE_STATES, QUESTION_KINDS, QUESTION_STATUSES, VALIDATION_OUTCOMES } from '../enums';

/**
 * The REST contract between apps/api and apps/web (`/api/v1`). Responses are presentation-ready
 * and in business language; the browser never derives a status, a result or an ERP id itself.
 * Money is integer paise, quantities integer milli-units, rates integer basis points.
 */

/** What a person sees as the invoice's status. */
export const UI_STATUSES = ['attention', 'processing', 'ready', 'handled', 'rejected'] as const;
export type UiStatus = (typeof UI_STATUSES)[number];

const int = z.int();

export const ApiFactSchema = z.object({
  label: z.string(),
  value: z.string(),
  tone: z.literal('attention').optional(),
});

export const ApiInputSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('value'),
    field: z.enum([
      'text',
      'gstin',
      'state',
      'date',
      'money',
      'signedMoney',
      'qty',
      'rate',
      'hsn',
      'uom',
    ]),
    label: z.string(),
    initial: z.string(),
  }),
  z.object({
    kind: z.literal('grn'),
    poLabel: z.string(),
    minDate: z.string(),
    maxDate: z.string(),
    lines: z.array(
      z.object({ poLineNo: int, label: z.string(), uom: z.string(), suggestedQty: z.string() }),
    ),
  }),
  z.object({
    kind: z.literal('item'),
    initial: z.object({
      name: z.string(),
      hsnSac: z.string(),
      uom: z.string(),
      gstRate: z.string(),
    }),
  }),
]);
export type ApiInputSpec = z.infer<typeof ApiInputSpecSchema>;

export const ApiOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  emphasis: z.enum(['primary', 'secondary', 'quiet']),
  /** What the confirmation says once chosen. */
  result: z.string(),
  input: ApiInputSpecSchema.nullable(),
  rejects: z.boolean(),
});
export type ApiOption = z.infer<typeof ApiOptionSchema>;

export const ApiQuestionSchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  code: z.string(),
  kind: z.enum(QUESTION_KINDS),
  status: z.enum(QUESTION_STATUSES),
  summary: z.string(),
  evidence: z.string(),
  headline: z.string(),
  facts: z.array(ApiFactSchema),
  why: z.array(z.string()),
  paths: z.array(z.string()),
  options: z.array(ApiOptionSchema),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  answer: z.object({ optionId: z.string(), label: z.string(), result: z.string() }).nullable(),
  invoice: z.object({
    number: z.string().nullable(),
    supplierName: z.string().nullable(),
    totalPaise: int.nullable(),
  }),
});
export type ApiQuestion = z.infer<typeof ApiQuestionSchema>;

export const ApiInvoiceSummarySchema = z.object({
  id: z.string(),
  documentId: z.string(),
  state: z.enum(INVOICE_STATES),
  status: z.enum(UI_STATUSES),
  number: z.string().nullable(),
  supplierName: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  totalPaise: int.nullable(),
  source: z.enum(['PDF', 'Photo']),
  filename: z.string(),
  receivedAt: z.string(),
  updatedAt: z.string(),
  /** The open question, if any, in queue form. */
  question: z.object({ id: z.string(), summary: z.string(), evidence: z.string() }).nullable(),
  /** The last decision the user made on this invoice, if any. */
  decision: z
    .object({ summary: z.string(), label: z.string(), result: z.string(), at: z.string() })
    .nullable(),
  /** Short note on what Veyra did, for finished invoices. */
  note: z.string().nullable(),
  failure: z.object({ stage: z.string(), reason: z.string() }).nullable(),
});
export type ApiInvoiceSummary = z.infer<typeof ApiInvoiceSummarySchema>;

export const ApiPartySchema = z.object({
  name: z.string().nullable(),
  gstin: z.string().nullable(),
  address: z.string().nullable(),
  state: z.string().nullable(),
  stateCode: z.string().nullable(),
});

export const ApiLineSchema = z.object({
  lineNo: int,
  description: z.string().nullable(),
  hsnSac: z.string().nullable(),
  qtyMilli: int.nullable(),
  uom: z.string().nullable(),
  unitPricePaise: int.nullable(),
  taxablePaise: int.nullable(),
  gstRateBp: int.nullable(),
});

export const ApiCheckSchema = z.object({
  rule: z.string(),
  name: z.string(),
  lineNo: int.nullable(),
  outcome: z.enum(VALIDATION_OUTCOMES),
  naReason: z.string().nullable(),
  message: z.string(),
});

export const ApiInvoiceDetailSchema = ApiInvoiceSummarySchema.extend({
  supplier: ApiPartySchema,
  buyer: ApiPartySchema,
  poNumber: z.string().nullable(),
  placeOfSupply: z.string().nullable(),
  supply: z.enum(['intra_state', 'inter_state']).nullable(),
  lines: z.array(ApiLineSchema),
  taxablePaise: int.nullable(),
  cgstPaise: int.nullable(),
  sgstPaise: int.nullable(),
  igstPaise: int.nullable(),
  roundOffPaise: int.nullable(),
  /** The total as read from the document, even when it is not clear enough to use. */
  readTotalPaise: int.nullable(),
  /** Calculated total → round-off → invoice total (decision D2). */
  totals: z
    .object({ calculatedPaise: int, roundOffPaise: int.nullable(), invoicePaise: int.nullable() })
    .nullable(),
  /** Paths read unclearly, for marking the document. */
  unclearPaths: z.array(z.string()),
  questions: z.array(ApiQuestionSchema),
  checks: z.array(ApiCheckSchema),
  erp: z.object({
    vendor: z.string().nullable(),
    poNumber: z.string().nullable(),
    purchaseInvoiceId: z.string().nullable(),
    records: z.array(z.string()),
  }),
});
export type ApiInvoiceDetail = z.infer<typeof ApiInvoiceDetailSchema>;

export const ApiInboxSchema = z.object({
  counts: z.object({
    received: int,
    needsYou: int,
    processing: int,
    handled: int,
    decidedByYou: int,
    ready: int,
    rejected: int,
  }),
  invoices: z.array(ApiInvoiceSummarySchema),
});
export type ApiInbox = z.infer<typeof ApiInboxSchema>;

export const ApiAuditEntrySchema = z.object({
  id: z.string(),
  invoiceId: z.string().nullable(),
  at: z.string(),
  title: z.string(),
  detail: z.string(),
  by: z.enum(['Veyra', 'You']),
  tone: z.enum(['neutral', 'handled', 'attention']),
});
export type ApiAuditEntry = z.infer<typeof ApiAuditEntrySchema>;

export const ApiAnswerBodySchema = z.object({
  optionId: z.string().min(1).max(200),
  input: z.unknown().optional(),
});

export const ApiErpSchema = {
  vendors: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      gstin: z.string(),
      state: z.string(),
      status: z.string(),
      origin: z.string(),
    }),
  ),
  items: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      hsnSac: z.string(),
      uom: z.string(),
      gstRateBp: int,
      origin: z.string(),
    }),
  ),
  purchaseOrders: z.array(
    z.object({
      poNumber: z.string(),
      vendor: z.string(),
      poDate: z.string(),
      lines: z.string(),
      status: z.string(),
      origin: z.string(),
    }),
  ),
  grns: z.array(
    z.object({
      grnNumber: z.string(),
      poNumber: z.string(),
      grnDate: z.string(),
      accepted: z.string(),
      origin: z.string(),
    }),
  ),
  purchaseInvoices: z.array(
    z.object({
      id: z.string(),
      vendorInvoiceNo: z.string(),
      vendor: z.string(),
      invoiceDate: z.string(),
      totalPaise: int,
      status: z.string(),
    }),
  ),
};

// ── Business record import (Phase 3C) ──────────────────────────────────────

export const ApiImportIssueSchema = z.object({
  /** Sheet the problem is on, or null for a file-level problem. */
  table: z.string().nullable(),
  file: z.string(),
  /** Spreadsheet row number as the user sees it, or null. */
  row: int.nullable(),
  column: z.string().nullable(),
  message: z.string(),
});
export type ApiImportIssue = z.infer<typeof ApiImportIssueSchema>;

export const ApiImportTableSchema = z.object({
  key: z.string(),
  label: z.string(),
  noun: z.tuple([z.string(), z.string()]),
  source: z.string(),
  rows: int,
  /** New records that will be added. */
  ready: int,
  /** Records that already exist with exactly these details (skipped). */
  existing: int,
  errors: int,
});
export type ApiImportTable = z.infer<typeof ApiImportTableSchema>;

const Counts = z.object({ vendors: int, items: int, purchaseOrders: int, grns: int });

export const ApiImportSchema = z.object({
  id: z.string(),
  status: z.enum(['ready', 'invalid', 'imported']),
  files: z.array(z.string()),
  kinds: z.string(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  tables: z.array(ApiImportTableSchema),
  errors: z.array(ApiImportIssueSchema),
  errorCount: int,
  notices: z.array(z.string()),
  canConfirm: z.boolean(),
  result: z.object({ created: Counts, skipped: Counts }).nullable(),
});
export type ApiImport = z.infer<typeof ApiImportSchema>;
