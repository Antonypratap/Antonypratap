import { createHash } from 'node:crypto';
import {
  cellValue,
  fieldOfHeader,
  norm,
  REGISTER_FIELDS,
  type RegisterField,
  type Row,
} from '../challenge/register';
import type { SheetRow } from '../spreadsheet/xlsx';

/**
 * Column mapping for a register kept in a spreadsheet (docs/ARCHITECTURE.md, data sources).
 * Veyrafy proposes which column holds which field; the person confirms or changes it, and the
 * confirmed mapping is what every sync uses. A proposal is only ever a suggestion on screen: no
 * value is read through a mapping nobody confirmed.
 */

/** Which column (0-based) holds each field; a field with no column is simply not held. */
export type Mapping = Partial<Record<RegisterField, number>>;

/**
 * Second-pass hints for column names the exact aliases do not know ("Vendor A/c", "Bill #").
 * Tried in order, on the normalised name, only for columns no exact alias claimed.
 */
const HINTS: readonly [RegisterField, RegExp, RegExp?][] = [
  [
    'invoiceNo',
    /(invoice|inv|bill|voucher)(no|num|number|ref)?$|^(invoice|inv|bill)/,
    /date|dt$|amount|total|value/,
  ],
  ['supplier', /supplier|vendor|party|creditor/, /code|gstin|gst|pan|id$|no$/],
  ['item', /item|material|product|description|particular|goods/, /code|hsn|no$/],
  ['hsn', /hsn|sac/],
  ['date', /date|dt$/],
  ['qty', /qty|quantity|qnty/],
  ['uom', /^(uom|unit)/],
  ['rate', /rate|price/, /tax|gst/],
  ['cgst', /cgst|centraltax/],
  ['sgst', /sgst|utgst|statetax/],
  ['igst', /igst|integratedtax/],
  ['total', /total|grand|invoiceamount|billamount|invoicevalue/],
  ['amount', /amount|value|taxable/, /tax|gst|total/],
  ['reference', /grn|receipt|voucher|entry|docno/],
];

/** The texts of a sheet row, as column names. */
export const headerTexts = (row: SheetRow | undefined): string[] =>
  row?.cells.map((c) => c.text.trim()) ?? [];

/** How many columns of a row are recognisable register column names. */
function recognised(row: SheetRow | undefined): number {
  const seen = new Set<RegisterField>();
  for (const t of headerTexts(row)) {
    const f = fieldOfHeader(t);
    if (f) seen.add(f);
  }
  return seen.size;
}

/**
 * The index (in `rows`) of the header row: the first of the first 10 rows naming at least two
 * register columns, else the first row that has any text (a title row above the header is common).
 */
export function detectHeaderRow(rows: readonly SheetRow[]): number {
  const scan = rows.slice(0, 10);
  const named = scan.findIndex((r) => recognised(r) >= 2);
  if (named >= 0) return named;
  const filled = scan.findIndex((r) => headerTexts(r).some((t) => t !== ''));
  return filled >= 0 ? filled : 0;
}

/** Veyrafy's proposal for a header: exact aliases first, then the hints. One column per field. */
export function proposeMapping(header: readonly string[]): Mapping {
  const mapping: Mapping = {};
  const taken = new Set<number>();
  header.forEach((h, i) => {
    const f = fieldOfHeader(h);
    if (f && mapping[f] === undefined) {
      mapping[f] = i;
      taken.add(i);
    }
  });
  for (const [field, match, unless] of HINTS) {
    if (mapping[field] !== undefined) continue;
    const i = header.findIndex((h, idx) => {
      const n = norm(h);
      return !taken.has(idx) && n !== '' && match.test(n) && !(unless?.test(n) ?? false);
    });
    if (i >= 0) {
      mapping[field] = i;
      taken.add(i);
    }
  }
  return mapping;
}

/** A mapping as received from a person: known fields, column numbers inside the header. */
export function cleanMapping(input: Record<string, unknown>, columns: number): Mapping {
  const mapping: Mapping = {};
  for (const f of REGISTER_FIELDS) {
    const v = input[f];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < columns) mapping[f] = v;
  }
  return mapping;
}

/** The rows below the header, read through the mapping, each with its row number in the sheet. */
export function applyMapping(
  rows: readonly SheetRow[],
  headerIndex: number,
  mapping: Mapping,
): { rows: Row[]; rowNumbers: number[] } {
  const out: Row[] = [];
  const rowNumbers: number[] = [];
  for (const r of rows.slice(headerIndex + 1)) {
    const row: Row = {};
    for (const f of REGISTER_FIELDS) {
      const col = mapping[f];
      if (col === undefined) continue;
      const v = cellValue(f, r.cells[col]);
      if (v !== undefined) row[f] = v;
    }
    out.push(row);
    rowNumbers.push(r.rowNumber);
  }
  return { rows: out, rowNumbers };
}

/**
 * A fingerprint of the header row. When a sheet's columns change (renamed, moved, removed), the
 * saved mapping may point at the wrong column, so a sync stops and asks for it to be reviewed.
 */
export function headerSignature(header: readonly string[]): string {
  const canonical = header.map((h) => norm(h)).join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Up to `n` non-empty example values of a column, for the mapping screen. */
export function sampleValues(
  rows: readonly SheetRow[],
  headerIndex: number,
  column: number,
  n = 3,
): string[] {
  const out: string[] = [];
  for (const r of rows.slice(headerIndex + 1)) {
    const t = r.cells[column]?.text.trim() ?? '';
    if (t !== '') out.push(t.length > 60 ? `${t.slice(0, 57)}…` : t);
    if (out.length >= n) break;
  }
  return out;
}
