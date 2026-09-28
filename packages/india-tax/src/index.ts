/**
 * @veyra/india-tax: India GST primitives (GSTIN, state codes, HSN/SAC, FY, GST arithmetic,
 * tax type, round-off, place-of-supply evidence). Pure, deterministic, integer-only.
 */
export const PACKAGE_NAME = '@veyra/india-tax';

export * from './states';
export * from './gstin';
export * from './hsn';
export * from './fy';
export * from './gst';
export * from './round-off';
export * from './place-of-supply';
