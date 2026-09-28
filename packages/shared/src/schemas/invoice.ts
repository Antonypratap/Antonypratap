import { z } from 'zod';
import { IsoDateSchema } from '../dates';
import { CURRENCIES } from '../enums';
import { NonNegativePaiseSchema, PaiseSchema } from '../money';
import { NonNegativeMilliQtySchema } from '../quantity';
import { RateBpSchema } from '../rate';
import { LineNoSchema, StateCodeSchema } from './common';

/**
 * The invoice as Veyra currently understands it: each value is the field's current value, or null
 * while it is missing / not usable. These are typed views; they carry no verdict about validity.
 */
export const InvoiceHeaderSchema = z.object({
  currency: z.enum(CURRENCIES),
  vendorName: z.string().min(1).nullable(),
  vendorGstin: z.string().min(1).nullable(),
  vendorAddress: z.string().min(1).nullable(),
  buyerGstin: z.string().min(1).nullable(),
  placeOfSupply: StateCodeSchema.nullable(),
  invoiceNumber: z.string().min(1).nullable(),
  invoiceDate: IsoDateSchema.nullable(),
  poNumber: z.string().min(1).nullable(),
  taxablePaise: NonNegativePaiseSchema.nullable(),
  cgstPaise: NonNegativePaiseSchema.nullable(),
  sgstPaise: NonNegativePaiseSchema.nullable(),
  igstPaise: NonNegativePaiseSchema.nullable(),
  /** Only non-null when a round-off line is printed on the invoice (decision D2). */
  roundOffPaise: PaiseSchema.nullable(),
  totalPaise: NonNegativePaiseSchema.nullable(),
});
export type InvoiceHeader = z.infer<typeof InvoiceHeaderSchema>;

export const InvoiceLineSchema = z.object({
  lineNo: LineNoSchema,
  description: z.string().min(1).nullable(),
  vendorItemCode: z.string().min(1).nullable(),
  hsnSac: z.string().regex(/^\d+$/).nullable(),
  qtyMilli: NonNegativeMilliQtySchema.nullable(),
  uom: z.string().min(1).nullable(),
  unitPricePaise: NonNegativePaiseSchema.nullable(),
  taxablePaise: NonNegativePaiseSchema.nullable(),
  gstRateBp: RateBpSchema.nullable(),
  cgstPaise: NonNegativePaiseSchema.nullable(),
  sgstPaise: NonNegativePaiseSchema.nullable(),
  igstPaise: NonNegativePaiseSchema.nullable(),
});
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>;
