import { z } from 'zod';
import {
  ErpIdSchema,
  GRN_ORIGINS,
  IdempotencyKeySchema,
  InvoiceIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  MASTER_ORIGINS,
  NonNegativeMilliQtySchema,
  NonNegativePaiseSchema,
  PO_ORIGINS,
  PO_STATUSES,
  PositiveMilliQtySchema,
  RateBpSchema,
  StateCodeSchema,
  UserIdSchema,
  VENDOR_STATUSES,
  normalizeInvoiceNumber,
  normalizeName,
} from '@veyra/shared';
import {
  FinancialYearSchema,
  GstinSchema,
  PanSchema,
  financialYearOf,
  isValidHsnSac,
} from '@veyra/india-tax';
import {
  checkInvoiceArithmetic,
  checkLineNumbers,
  headerAmountShape,
  issue,
  lineTaxShape,
} from './internal';

/**
 * ERP records as every ErpConnector returns them (ARCHITECTURE §4.1). A connector must return
 * values that parse with these schemas; the invariants below are part of the contract.
 */

const text = z.string().min(1);

export const HsnSacSchema = z.string().refine(isValidHsnSac, 'HSN/SAC must be 4, 6 or 8 digits');

export const CompanySchema = z
  .object({ id: ErpIdSchema, name: text, gstin: GstinSchema, stateCode: StateCodeSchema })
  .superRefine((c, ctx) => {
    if (c.stateCode !== c.gstin.slice(0, 2)) issue(ctx, 'stateCode must match the GSTIN');
  });
export type Company = z.infer<typeof CompanySchema>;

export const VendorSchema = z
  .object({
    id: ErpIdSchema,
    code: text,
    name: text,
    nameNormalized: z.string(),
    gstin: GstinSchema,
    pan: PanSchema,
    stateCode: StateCodeSchema,
    address: text,
    status: z.enum(VENDOR_STATUSES),
    origin: z.enum(MASTER_ORIGINS),
    sourceInvoiceId: InvoiceIdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .superRefine((v, ctx) => {
    if (v.pan !== v.gstin.slice(2, 12)) issue(ctx, 'pan must be GSTIN characters 3–12');
    if (v.stateCode !== v.gstin.slice(0, 2)) issue(ctx, 'stateCode must be GSTIN characters 1–2');
    if (v.nameNormalized !== normalizeName(v.name))
      issue(ctx, 'nameNormalized must equal normalizeName(name)');
    if ((v.origin === 'created_by_veyra') !== (v.sourceInvoiceId !== null)) {
      issue(ctx, 'sourceInvoiceId is set exactly for records created by Veyra');
    }
  });
export type Vendor = z.infer<typeof VendorSchema>;

export const ItemSchema = z
  .object({
    id: ErpIdSchema,
    code: text,
    name: text,
    nameNormalized: z.string(),
    hsnSac: HsnSacSchema,
    uom: text,
    gstRateBp: RateBpSchema,
    origin: z.enum(MASTER_ORIGINS),
    sourceInvoiceId: InvoiceIdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .superRefine((i, ctx) => {
    if (i.nameNormalized !== normalizeName(i.name))
      issue(ctx, 'nameNormalized must equal normalizeName(name)');
    if ((i.origin === 'created_by_veyra') !== (i.sourceInvoiceId !== null)) {
      issue(ctx, 'sourceInvoiceId is set exactly for records created by Veyra');
    }
  });
export type Item = z.infer<typeof ItemSchema>;

export const VendorItemAliasSchema = z
  .object({
    id: ErpIdSchema,
    vendorId: ErpIdSchema,
    vendorItemCode: text,
    itemId: ErpIdSchema,
    origin: z.enum(MASTER_ORIGINS),
    sourceInvoiceId: InvoiceIdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .superRefine((a, ctx) => {
    if ((a.origin === 'created_by_veyra') !== (a.sourceInvoiceId !== null)) {
      issue(ctx, 'sourceInvoiceId is set exactly for records created by Veyra');
    }
  });
export type VendorItemAlias = z.infer<typeof VendorItemAliasSchema>;

export const PoLineSchema = z.object({
  id: ErpIdSchema,
  poId: ErpIdSchema,
  lineNo: z.int().positive(),
  itemId: ErpIdSchema,
  qtyMilli: PositiveMilliQtySchema,
  unitPricePaise: NonNegativePaiseSchema,
  gstRateBp: RateBpSchema,
});
export type PoLine = z.infer<typeof PoLineSchema>;

export const PurchaseOrderSchema = z
  .object({
    id: ErpIdSchema,
    poNumber: text,
    vendorId: ErpIdSchema,
    poDate: IsoDateSchema,
    status: z.enum(PO_STATUSES),
    origin: z.enum(PO_ORIGINS),
    sourceInvoiceId: InvoiceIdSchema.nullable(),
    approvedByUserId: UserIdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    lines: z.array(PoLineSchema).min(1),
  })
  .superRefine((po, ctx) => {
    checkLineNumbers(po.lines, ctx);
    if (po.lines.some((l) => l.poId !== po.id)) issue(ctx, 'every line belongs to this PO');
    const fromInvoice = po.origin !== 'seed';
    if (fromInvoice !== (po.sourceInvoiceId !== null))
      issue(ctx, 'sourceInvoiceId is set exactly for POs created from an invoice');
    if ((po.origin === 'created_from_invoice_on_approval') !== (po.approvedByUserId !== null)) {
      issue(ctx, 'approvedByUserId is set exactly for POs created on approval');
    }
  });
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

export const GrnLineSchema = z
  .object({
    id: ErpIdSchema,
    grnId: ErpIdSchema,
    poLineId: ErpIdSchema,
    receivedQtyMilli: NonNegativeMilliQtySchema,
    acceptedQtyMilli: NonNegativeMilliQtySchema,
  })
  .superRefine((l, ctx) => {
    if (l.acceptedQtyMilli > l.receivedQtyMilli)
      issue(ctx, 'accepted quantity cannot exceed received quantity');
  });
export type GrnLine = z.infer<typeof GrnLineSchema>;

export const GrnSchema = z
  .object({
    id: ErpIdSchema,
    grnNumber: text,
    poId: ErpIdSchema,
    grnDate: IsoDateSchema,
    origin: z.enum(GRN_ORIGINS),
    confirmedByUserId: UserIdSchema.nullable(),
    sourceInvoiceId: InvoiceIdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    lines: z.array(GrnLineSchema).min(1),
  })
  .superRefine((g, ctx) => {
    if (g.lines.some((l) => l.grnId !== g.id)) issue(ctx, 'every line belongs to this GRN');
    const viaVeyra = g.origin === 'user_confirmed_via_veyra';
    if (viaVeyra !== (g.confirmedByUserId !== null) || viaVeyra !== (g.sourceInvoiceId !== null)) {
      issue(
        ctx,
        'GRNs created via Veyra record the confirming user and source invoice; seeded GRNs do not',
      );
    }
  });
export type Grn = z.infer<typeof GrnSchema>;

export const PurchaseInvoiceLineSchema = z.object({
  id: ErpIdSchema,
  purchaseInvoiceId: ErpIdSchema,
  lineNo: z.int().positive(),
  poLineId: ErpIdSchema,
  itemId: ErpIdSchema,
  qtyMilli: PositiveMilliQtySchema,
  unitPricePaise: NonNegativePaiseSchema,
  taxablePaise: NonNegativePaiseSchema,
  gstRateBp: RateBpSchema,
  ...lineTaxShape,
});
export type PurchaseInvoiceLine = z.infer<typeof PurchaseInvoiceLineSchema>;

export const PurchaseInvoiceSchema = z
  .object({
    id: ErpIdSchema,
    vendorId: ErpIdSchema,
    vendorInvoiceNo: text,
    vendorInvoiceNoNormalized: text,
    invoiceDate: IsoDateSchema,
    fy: FinancialYearSchema,
    poId: ErpIdSchema,
    ...headerAmountShape,
    /** The only status V1 knows. There is no paid status: Veyra never executes payment. */
    status: z.literal('verified_pending_payment'),
    veyraInvoiceId: InvoiceIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    createdAt: IsoDateTimeSchema,
    lines: z.array(PurchaseInvoiceLineSchema).min(1),
  })
  .superRefine((inv, ctx) => {
    checkLineNumbers(inv.lines, ctx);
    if (inv.lines.some((l) => l.purchaseInvoiceId !== inv.id))
      issue(ctx, 'every line belongs to this invoice');
    if (inv.vendorInvoiceNoNormalized !== normalizeInvoiceNumber(inv.vendorInvoiceNo)) {
      issue(ctx, 'vendorInvoiceNoNormalized must equal normalizeInvoiceNumber(vendorInvoiceNo)');
    }
    if (inv.fy !== financialYearOf(inv.invoiceDate))
      issue(ctx, 'fy must be the financial year of invoiceDate');
    if (inv.idempotencyKey !== `veyra:${inv.veyraInvoiceId}:purchase_invoice`) {
      issue(ctx, 'idempotencyKey must be veyra:<veyraInvoiceId>:purchase_invoice');
    }
    checkInvoiceArithmetic(inv, ctx);
  });
export type PurchaseInvoice = z.infer<typeof PurchaseInvoiceSchema>;
