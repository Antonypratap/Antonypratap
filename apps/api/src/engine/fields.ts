import {
  IsoDateSchema,
  normalizeUom,
  parseMoney,
  parseQuantity,
  parseRatePercent,
  type Evidence,
  type FieldPath,
  type FieldSource,
  type HeaderFieldKey,
  type LineFieldKey,
} from '@veyra/shared';
import { isValidHsnSac, resolveStateCode } from '@veyra/india-tax';

/**
 * Invoice fields as Veyra holds them (the `extracted_fields` table), and the deterministic rules
 * for when a value may be used (RULES §1.3–1.4). Nothing here guesses or fills a value from
 * elsewhere: a value is usable, or it is not.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface StoredField {
  path: FieldPath;
  value: JsonValue;
  confidenceBp: number | null;
  source: FieldSource;
  evidence: Evidence | null;
  evidenceDetail: Record<string, JsonValue> | null;
}

export type FieldKind =
  'text' | 'gstin' | 'state' | 'date' | 'money' | 'signedMoney' | 'qty' | 'rate' | 'hsn' | 'uom';

export const HEADER_KINDS: Record<HeaderFieldKey, FieldKind> = {
  vendorName: 'text',
  vendorGstin: 'gstin',
  vendorAddress: 'text',
  vendorPan: 'text',
  buyerGstin: 'gstin',
  billingAddress: 'text',
  placeOfSupply: 'state',
  shipToState: 'state',
  shipToGstin: 'gstin',
  shipToAddress: 'text',
  invoiceNumber: 'text',
  invoiceDate: 'date',
  poNumber: 'text',
  taxablePaise: 'money',
  cgstPaise: 'money',
  sgstPaise: 'money',
  igstPaise: 'money',
  cessPaise: 'money',
  roundOffPaise: 'signedMoney',
  totalPaise: 'money',
};

export const LINE_KINDS: Record<LineFieldKey, FieldKind> = {
  description: 'text',
  vendorItemCode: 'text',
  hsnSac: 'hsn',
  qtyMilli: 'qty',
  uom: 'uom',
  unitPricePaise: 'money',
  discountPaise: 'money',
  taxablePaise: 'money',
  gstRateBp: 'rate',
  cgstPaise: 'money',
  sgstPaise: 'money',
  igstPaise: 'money',
  lineTotalPaise: 'money',
};

export function kindOfPath(path: FieldPath): FieldKind {
  const header = /^header\.(\w+)$/.exec(path);
  if (header) return HEADER_KINDS[header[1] as HeaderFieldKey];
  const line = /^lines\[\d+\]\.(\w+)$/.exec(path);
  return LINE_KINDS[(line?.[1] ?? 'description') as LineFieldKey];
}

/** GSTIN format (RULES §1.4). State code and checksum are rule R03, not the parser. */
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const isSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Parses a stored value (extracted, or canonical human input) into its canonical form, or null. */
export function parseStored(kind: FieldKind, value: JsonValue): string | number | null {
  switch (kind) {
    case 'text':
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    case 'gstin':
      return typeof value === 'string' && GSTIN_FORMAT.test(value.trim().toUpperCase())
        ? value.trim().toUpperCase()
        : null;
    case 'state': {
      if (typeof value !== 'string') return null;
      const r = resolveStateCode(value);
      return r.ok ? r.value : null;
    }
    case 'date':
      return IsoDateSchema.safeParse(value).success ? (value as string) : null;
    case 'money':
    case 'qty':
      return isSafeInt(value) && value >= 0 ? value : null;
    case 'signedMoney':
      return isSafeInt(value) ? value : null;
    case 'rate':
      return isSafeInt(value) && value >= 0 && value <= 10_000 ? value : null;
    case 'hsn':
      return typeof value === 'string' && isValidHsnSac(value) ? value : null;
    case 'uom':
      return typeof value === 'string' ? normalizeUom(value) : null;
  }
}

/**
 * Parses what the designated user typed into the canonical stored value. Returns an error message
 * the user can act on. Money is never rounded: more than 2 decimals is refused.
 */
export function parseUserInput(
  kind: FieldKind,
  raw: string,
): { ok: true; value: string | number } | { ok: false; message: string } {
  const text = raw.trim();
  const fail = (message: string) => ({ ok: false as const, message });
  if (text === '') return fail('Enter a value.');
  switch (kind) {
    case 'text':
      return { ok: true, value: text };
    case 'gstin':
      return GSTIN_FORMAT.test(text.toUpperCase())
        ? { ok: true, value: text.toUpperCase() }
        : fail('A GSTIN has 15 characters, like 29AAFCS5678K1ZK.');
    case 'state': {
      const r = resolveStateCode(text);
      return r.ok ? { ok: true, value: r.value } : fail('Enter a state name or its 2-digit code.');
    }
    case 'date': {
      const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
      const iso = dmy ? `${dmy[3]}-${dmy[2]?.padStart(2, '0')}-${dmy[1]?.padStart(2, '0')}` : text;
      return IsoDateSchema.safeParse(iso).success
        ? { ok: true, value: iso }
        : fail('Enter a date as DD/MM/YYYY.');
    }
    case 'money':
    case 'signedMoney': {
      const r = parseMoney(text, { allowNegative: kind === 'signedMoney' });
      return r.ok ? { ok: true, value: r.value } : fail('Enter an amount like 16,048.00.');
    }
    case 'qty': {
      const r = parseQuantity(text);
      return r.ok ? { ok: true, value: r.value } : fail('Enter a quantity with up to 3 decimals.');
    }
    case 'rate': {
      const r = parseRatePercent(text);
      return r.ok ? { ok: true, value: r.value } : fail('Enter a rate like 18%.');
    }
    case 'hsn':
      return isValidHsnSac(text)
        ? { ok: true, value: text }
        : fail('An HSN/SAC code has 4, 6 or 8 digits.');
    case 'uom': {
      const u = normalizeUom(text);
      return u ? { ok: true, value: u } : fail('Use a unit like KGS, NOS, PCS, BOX or REAM.');
    }
  }
}

/**
 * - usable: may be used (RULES §1.3)
 * - absent: not printed (the extractor is confident nothing is there)
 * - low_confidence: something is there but it was not read reliably
 * - unparseable: read, but fails its format parser
 */
export type FieldState = 'usable' | 'absent' | 'low_confidence' | 'unparseable';

export interface FieldRead<T> {
  state: FieldState;
  value: T | null;
  field: StoredField | undefined;
}

const HUMAN_OR_DERIVED: ReadonlySet<FieldSource> = new Set([
  'human_confirmed',
  'human_corrected',
  'derived_from_erp_choice',
  'derived_from_document_evidence',
]);

export function readField<T extends string | number>(
  fields: ReadonlyMap<string, StoredField>,
  path: FieldPath,
  minConfidenceBp: number,
): FieldRead<T> {
  const field = fields.get(path);
  if (!field) return { state: 'absent', value: null, field };
  const trusted = HUMAN_OR_DERIVED.has(field.source);
  if (field.value === null) {
    return {
      state: trusted || (field.confidenceBp ?? 0) >= minConfidenceBp ? 'absent' : 'low_confidence',
      value: null,
      field,
    };
  }
  if (!trusted && (field.confidenceBp ?? 0) < minConfidenceBp)
    return { state: 'low_confidence', value: null, field };
  const parsed = parseStored(kindOfPath(path), field.value);
  if (parsed === null) return { state: 'unparseable', value: null, field };
  return { state: 'usable', value: parsed as T, field };
}
