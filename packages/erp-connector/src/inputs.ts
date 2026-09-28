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
