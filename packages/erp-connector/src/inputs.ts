import { z } from 'zod';
import {
  ErpIdSchema,
  InvoiceIdSchema,
  IsoDateSchema,
  NonNegativeMilliQtySchema,
  NonNegativePaiseSchema,
  PositiveMilliQtySchema,
  RateBpSchema,
  UserIdSchema,
} from '@veyra/shared';
import { GstinSchema } from '@veyra/india-tax';
import { HsnSacSchema } from './entities';
import {
  checkInvoiceArithmetic,
  checkLineNumbers,
  headerAmountShape,
  lineTaxShape,
} from './internal';

/**
 * Inputs to ERP writes. Only the COMMITTING stage calls these (ARCHITECTURE §4.3). The connector
 * derives what is deterministic (PAN and state from GSTIN, normalised names, FY, record numbers).
 */

const text = z.string().min(1);

export const CreateVendorInputSchema = z.object({
  name: text,
  gstin: GstinSchema,
  address: text,
  sourceInvoiceId: InvoiceIdSchema,
});
export type CreateVendorInput = z.input<typeof CreateVendorInputSchema>;

export const ReactivateVendorInputSchema = z.object({
  vendorId: ErpIdSchema,
  sourceInvoiceId: InvoiceIdSchema,
  approvedByUserId: UserIdSchema,
});
export type ReactivateVendorInput = z.input<typeof ReactivateVendorInputSchema>;

/** Item masters are only ever created after the designated user's approval (RULES §3.2). */
export const CreateItemInputSchema = z.object({
  name: text,
  hsnSac: HsnSacSchema,
  uom: text,
  gstRateBp: RateBpSchema,
  sourceInvoiceId: InvoiceIdSchema,
  approvedByUserId: UserIdSchema,
});
export type CreateItemInput = z.input<typeof CreateItemInputSchema>;

export const CreateVendorItemAliasInputSchema = z.object({
  vendorId: ErpIdSchema,
  vendorItemCode: text,
  itemId: ErpIdSchema,
  sourceInvoiceId: InvoiceIdSchema,
});
export type CreateVendorItemAliasInput = z.input<typeof CreateVendorItemAliasInputSchema>;

/**
 * POs are created only from an invoice, under the PO policy (RULES §3.4). The ERP assigns the PO
 * number; Veyra never supplies one, so a number printed on an invoice can never be reused.
 */
export const CreatePurchaseOrderInputSchema = z
  .object({
    vendorId: ErpIdSchema,
    poDate: IsoDateSchema,
    origin: z.enum(['auto_created_from_invoice', 'created_from_invoice_on_approval']),
    sourceInvoiceId: InvoiceIdSchema,
    approvedByUserId: UserIdSchema.nullable(),
    lines: z
      .array(
        z.object({
          lineNo: z.int().positive(),
          itemId: ErpIdSchema,
          qtyMilli: PositiveMilliQtySchema,
          unitPricePaise: NonNegativePaiseSchema,
          gstRateBp: RateBpSchema,
        }),
      )
      .min(1),
  })
  .superRefine((po, ctx) => {
    checkLineNumbers(po.lines, ctx);
    if ((po.origin === 'created_from_invoice_on_approval') !== (po.approvedByUserId !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'approvedByUserId is required exactly for POs created on approval',
      });
    }
  });
export type CreatePurchaseOrderInput = z.input<typeof CreatePurchaseOrderInputSchema>;

/** GRNs are created only from the designated user's explicit confirmation (RULES §3.5). */
export const CreateGrnInputSchema = z
  .object({
    poId: ErpIdSchema,
    grnDate: IsoDateSchema,
    confirmedByUserId: UserIdSchema,
    sourceInvoiceId: InvoiceIdSchema,
    lines: z
      .array(
        z.object({
          poLineId: ErpIdSchema,
          receivedQtyMilli: PositiveMilliQtySchema,
          acceptedQtyMilli: NonNegativeMilliQtySchema,
        }),
      )
      .min(1),
  })
  .superRefine((grn, ctx) => {
    if (grn.lines.some((l) => l.acceptedQtyMilli > l.receivedQtyMilli)) {
      ctx.addIssue({
        code: 'custom',
        message: 'accepted quantity cannot exceed received quantity',
      });
    }
    if (new Set(grn.lines.map((l) => l.poLineId)).size !== grn.lines.length) {
      ctx.addIssue({ code: 'custom', message: 'each PO line appears at most once' });
    }
  });
export type CreateGrnInput = z.input<typeof CreateGrnInputSchema>;

export const RecordPurchaseInvoiceInputSchema = z
  .object({
    vendorId: ErpIdSchema,
    vendorInvoiceNo: text,
    invoiceDate: IsoDateSchema,
    poId: ErpIdSchema,
    ...headerAmountShape,
    veyraInvoiceId: InvoiceIdSchema,
    lines: z
      .array(
        z.object({
          lineNo: z.int().positive(),
          poLineId: ErpIdSchema,
          itemId: ErpIdSchema,
          qtyMilli: PositiveMilliQtySchema,
          unitPricePaise: NonNegativePaiseSchema,
          taxablePaise: NonNegativePaiseSchema,
          gstRateBp: RateBpSchema,
          ...lineTaxShape,
        }),
      )
      .min(1),
  })
  .superRefine((inv, ctx) => {
    checkLineNumbers(inv.lines, ctx);
    checkInvoiceArithmetic(inv, ctx);
  });
export type RecordPurchaseInvoiceInput = z.input<typeof RecordPurchaseInvoiceInputSchema>;

/**
 * A batch of the business's own purchasing records (Phase 3C import). Records reference each
 * other by BUSINESS keys (vendor code, item code, PO number, PO line number), never by ERP ids:
 * the connector resolves them. The connector applies the whole batch atomically: a record whose
 * natural key already exists with identical values is skipped; one that exists with different
 * values is a CONFLICT and nothing is written. Existing records are never changed.
 */
const code = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, 'letters, digits, space, . _ / - only');

export const ImportVendorSchema = z.object({
  code,
  name: text.max(200),
  gstin: GstinSchema,
  address: text.max(500),
  status: z.enum(['active', 'inactive']),
});

export const ImportItemSchema = z.object({
  code,
  name: text.max(200),
  hsnSac: HsnSacSchema,
  uom: text.max(10),
  gstRateBp: RateBpSchema,
});

export const ImportPurchaseOrderSchema = z
  .object({
    poNumber: code,
    vendorCode: code,
    poDate: IsoDateSchema,
    status: z.enum(['open', 'closed']),
    lines: z
      .array(
        z.object({
          lineNo: z.int().positive(),
          itemCode: code,
          qtyMilli: PositiveMilliQtySchema,
          unitPricePaise: NonNegativePaiseSchema,
          gstRateBp: RateBpSchema,
        }),
      )
      .min(1),
  })
  .superRefine((po, ctx) => checkLineNumbers(po.lines, ctx));

export const ImportGrnSchema = z
  .object({
    grnNumber: code,
    poNumber: code,
    grnDate: IsoDateSchema,
    lines: z
      .array(
        z.object({
          poLineNo: z.int().positive(),
          receivedQtyMilli: PositiveMilliQtySchema,
          acceptedQtyMilli: NonNegativeMilliQtySchema,
        }),
      )
      .min(1),
  })
  .superRefine((grn, ctx) => {
    if (grn.lines.some((l) => l.acceptedQtyMilli > l.receivedQtyMilli))
      ctx.addIssue({
        code: 'custom',
        message: 'accepted quantity cannot exceed received quantity',
      });
    if (new Set(grn.lines.map((l) => l.poLineNo)).size !== grn.lines.length)
      ctx.addIssue({ code: 'custom', message: 'each PO line appears at most once' });
  });

const unique = <T>(
  rows: readonly T[],
  key: (r: T) => string,
  what: string,
  ctx: z.RefinementCtx,
) => {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `duplicate ${what} ${k}` });
    seen.add(k);
  }
};

export const ImportBusinessRecordsInputSchema = z
  .object({
    /** Veyra's id for this import; recorded on every record it creates. */
    importId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    vendors: z.array(ImportVendorSchema).max(20_000),
    items: z.array(ImportItemSchema).max(20_000),
    purchaseOrders: z.array(ImportPurchaseOrderSchema).max(20_000),
    grns: z.array(ImportGrnSchema).max(20_000),
  })
  .superRefine((b, ctx) => {
    unique(b.vendors, (v) => v.code, 'vendor code', ctx);
    unique(b.vendors, (v) => v.gstin, 'vendor GSTIN', ctx);
    unique(b.items, (i) => i.code, 'item code', ctx);
    unique(b.purchaseOrders, (p) => p.poNumber, 'PO number', ctx);
    unique(b.grns, (g) => g.grnNumber, 'GRN number', ctx);
  });
export type ImportBusinessRecordsInput = z.input<typeof ImportBusinessRecordsInputSchema>;

export interface ImportCounts {
  vendors: number;
  items: number;
  purchaseOrders: number;
  grns: number;
}

/** What an import did: records created, and records that already existed exactly (skipped). */
export interface ImportBusinessRecordsResult {
  importId: string;
  created: ImportCounts;
  skipped: ImportCounts;
}
