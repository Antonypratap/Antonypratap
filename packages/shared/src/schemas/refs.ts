import { z } from 'zod';
import { GRN_ORIGINS, PO_ORIGINS, PO_STATUSES, VENDOR_STATUSES } from '../enums';
import { ErpIdSchema } from '../ids';
import { RateBpSchema } from '../rate';
import { StateCodeSchema } from './common';

/**
 * Lightweight references to ERP records, used in DTOs, match candidates and questions.
 * Full ERP records are defined by @veyra/erp-connector.
 */
export const VendorRefSchema = z.object({
  erpId: ErpIdSchema,
  code: z.string().min(1),
  name: z.string().min(1),
  gstin: z.string().length(15),
  stateCode: StateCodeSchema,
  status: z.enum(VENDOR_STATUSES),
});
export type VendorRef = z.infer<typeof VendorRefSchema>;

export const ItemRefSchema = z.object({
  erpId: ErpIdSchema,
  code: z.string().min(1),
  name: z.string().min(1),
  hsnSac: z.string().regex(/^\d+$/),
  uom: z.string().min(1),
  gstRateBp: RateBpSchema,
});
export type ItemRef = z.infer<typeof ItemRefSchema>;

export const PoRefSchema = z.object({
  erpId: ErpIdSchema,
  poNumber: z.string().min(1),
  vendorErpId: ErpIdSchema,
  status: z.enum(PO_STATUSES),
  origin: z.enum(PO_ORIGINS),
});
export type PoRef = z.infer<typeof PoRefSchema>;

export const GrnRefSchema = z.object({
  erpId: ErpIdSchema,
  grnNumber: z.string().min(1),
  poErpId: ErpIdSchema,
  origin: z.enum(GRN_ORIGINS),
});
export type GrnRef = z.infer<typeof GrnRefSchema>;
