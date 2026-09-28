import { z } from 'zod';

/** Header fields an extractor reads (ARCHITECTURE §3.1). Ship-to fields support place-of-supply evidence (RULES §1.6). */
export const HEADER_FIELD_KEYS = [
  'vendorName',
  'vendorGstin',
  'vendorAddress',
  'buyerGstin',
  'placeOfSupply',
  'shipToState',
  'shipToGstin',
  'invoiceNumber',
  'invoiceDate',
  'poNumber',
  'taxablePaise',
  'cgstPaise',
  'sgstPaise',
  'igstPaise',
  'roundOffPaise',
  'totalPaise',
] as const;
export type HeaderFieldKey = (typeof HEADER_FIELD_KEYS)[number];

export const LINE_FIELD_KEYS = [
  'description',
  'vendorItemCode',
  'hsnSac',
  'qtyMilli',
  'uom',
  'unitPricePaise',
  'taxablePaise',
  'gstRateBp',
  'cgstPaise',
  'sgstPaise',
  'igstPaise',
] as const;
export type LineFieldKey = (typeof LINE_FIELD_KEYS)[number];

/** Required header fields (RULES §1.2). Applicable tax heads are decided by the rules, not here. */
export const REQUIRED_HEADER_FIELDS = [
  'vendorGstin',
  'vendorName',
  'buyerGstin',
  'placeOfSupply',
  'invoiceNumber',
  'invoiceDate',
  'taxablePaise',
  'totalPaise',
] as const satisfies readonly HeaderFieldKey[];

export const REQUIRED_LINE_FIELDS = [
  'description',
  'hsnSac',
  'qtyMilli',
  'uom',
  'unitPricePaise',
  'taxablePaise',
  'gstRateBp',
] as const satisfies readonly LineFieldKey[];

/**
 * Address of one field: `header.<key>` or `lines[<n>].<key>`, where `n` is the 1-based line
 * number (the same number used by `line:<n>` subject keys and `lineNo`).
 */
export type FieldPath = `header.${HeaderFieldKey}` | `lines[${number}].${LineFieldKey}`;

const HEADER_PATH = /^header\.([A-Za-z]+)$/;
const LINE_PATH = /^lines\[([1-9]\d*)\]\.([A-Za-z]+)$/;

export function isFieldPath(value: string): value is FieldPath {
  const header = HEADER_PATH.exec(value);
  if (header) return (HEADER_FIELD_KEYS as readonly string[]).includes(header[1] ?? '');
  const line = LINE_PATH.exec(value);
  if (line) return (LINE_FIELD_KEYS as readonly string[]).includes(line[2] ?? '');
  return false;
}

export const FieldPathSchema = z.custom<FieldPath>(
  (v) => typeof v === 'string' && isFieldPath(v),
  'expected header.<field> or lines[<n>].<field> with a known field',
);

export function headerPath(key: HeaderFieldKey): FieldPath {
  return `header.${key}`;
}

export function linePath(lineNo: number, key: LineFieldKey): FieldPath {
  if (!Number.isSafeInteger(lineNo) || lineNo < 1)
    throw new RangeError('lineNo must be a positive integer');
  return `lines[${lineNo}].${key}`;
}
