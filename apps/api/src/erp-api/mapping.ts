import { createHash } from 'node:crypto';
import { canonicalJson } from '@veyra/erp-connector';
import {
  FIELDS,
  type Conversion,
  type Entity,
  type EntityConfig,
  type FieldMapping,
  type FieldSpec,
  type Profile,
} from './profile';

/**
 * From an ERP's JSON record to Veyrafy's form (a "mirror document"), through the person's mapping.
 * A record either maps completely (every required field present and readable) or is kept out as
 * invalid, naming the fields that failed and never their values. Nothing is guessed: a value that
 * does not convert cleanly is an error, not a default.
 */

export interface VendorDoc {
  code: string | null;
  name: string;
  gstin: string | null;
  address: string | null;
  status: 'active' | 'inactive' | null;
}
export interface ItemDoc {
  code: string | null;
  name: string;
  hsnSac: string | null;
  uom: string | null;
  gstRateBp: number | null;
}
export interface PoDoc {
  poNumber: string;
  vendorRef: string;
  poDate: string;
  status: 'open' | 'closed' | null;
  lines: {
    lineRef: string | null;
    lineNo: number | null;
    itemRef: string;
    qtyMilli: number;
    unitPricePaise: number;
    gstRateBp: number | null;
  }[];
}
export interface GrnDoc {
  grnNumber: string;
  poRef: string;
  grnDate: string;
  lines: {
    poLineRef: string | null;
    itemRef: string | null;
    receivedQtyMilli: number | null;
    acceptedQtyMilli: number;
  }[];
}
export interface BillDoc {
  billNumber: string;
  vendorRef: string;
  billDate: string;
  totalPaise: number | null;
  poRef: string | null;
  paymentStatus: string | null;
}
export interface DocOf {
  vendors: VendorDoc;
  items: ItemDoc;
  purchase_orders: PoDoc;
  grns: GrnDoc;
  bills: BillDoc;
}

export interface MappedRecord<E extends Entity = Entity> {
  erpId: string;
  doc: DocOf[E];
  /** The record's own "last changed" time, when the ERP gives one (ISO). */
  sourceUpdatedAt: string | null;
  company: string | null;
  outlet: string | null;
  /**
   * SHA-256 of the record as received and the mapping it was read with: a repeated sync of an
   * unchanged record changes nothing, and a changed mapping rewrites it.
   */
  rawHash: string;
}

export interface InvalidRecord {
  /** The ERP's ID when it could be read (to name the record in the issue), else null. */
  erpId: string | null;
  /** Field keys that were missing or unreadable. Never values. */
  fields: string[];
}

export type MapResult<E extends Entity = Entity> =
  | { ok: true; record: MappedRecord<E> }
  | { ok: false; invalid: InvalidRecord }
  | { ok: 'out_of_scope' };

/** Reads a dotted path ("data.items", "vendor.code", "lines.0.qty"). */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(part);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * A date as Indian ERPs write it: 2026-09-22, 2026-09-22T10:30:00Z, 22-09-2026, 22/09/2026,
 * 22.09.2026, 22-Sep-2026, 22 Sep 2026. Day-first for numeric dates (the Indian convention); an
 * ambiguous or impossible date is an error, never a guess.
 */
export function parseDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ,]+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[(m[2] ?? '').toLowerCase()];
    return month ? isoDate(Number(m[3]), month, Number(m[1])) : null;
  }
  return null;
}

/** A decimal number from a JSON number or a numeric string ("1,234.50" allowed). */
function decimal(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const ACTIVE = /^(active|open|approved|released|enabled|yes|y|true|1|a)$/i;
const INACTIVE =
  /^(inactive|closed|cancelled|canceled|blocked|disabled|completed|no|n|false|0|i|c)$/i;

/** Converts one value; undefined when absent, null when present but unreadable. */
export function convert(
  value: unknown,
  how: Conversion,
): string | number | boolean | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  switch (how) {
    case 'text': {
      if (typeof value === 'string') return value.trim() || undefined;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      return null;
    }
    case 'rupees':
    case 'quantity':
    case 'percent': {
      const n = decimal(value);
      return n === null || n < 0
        ? null
        : Math.round(n * (how === 'percent' ? 100 : how === 'rupees' ? 100 : 1000));
    }
    case 'paise':
    case 'milli':
    case 'basis_points': {
      const n = decimal(value);
      return n === null || n < 0 || !Number.isInteger(n) ? null : n;
    }
    case 'date':
      return parseDate(value);
    case 'status': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim();
      return ACTIVE.test(s) ? true : INACTIVE.test(s) ? false : null;
    }
  }
}

function readFields(
  raw: unknown,
  specs: FieldSpec[],
  mapping: Record<string, FieldMapping>,
  bad: string[],
  prefix = '',
): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const spec of specs) {
    const m = mapping[spec.key];
    if (!m?.path) continue;
    const v = convert(getPath(raw, m.path), m.convert ?? spec.convert);
    if (v === null) bad.push(prefix + spec.key);
    else out[spec.key] = v;
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function updatedAtIso(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function hashRaw(raw: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(raw as never))
    .digest('hex');
}

/**
 * The settings a record type's mapped records depend on: its mapping and the scope. Part of each
 * record's hash, so a changed mapping rewrites records whose ERP data did not change.
 */
export function mappingHash(config: EntityConfig, scope: Profile['scope']): string {
  return hashRaw({ config, scope });
}

/** Maps one raw record of `entity` through the profile; see MapResult. */
export function mapRecord<E extends Entity>(
  entity: E,
  raw: unknown,
  config: EntityConfig,
  scope: Profile['scope'],
): MapResult<E> {
  const spec = FIELDS[entity];
  const bad: string[] = [];
  const h = readFields(raw, spec.header, config.fields, bad);
  for (const s of spec.header)
    if (s.required && h[s.key] === undefined && !bad.includes(s.key)) bad.push(s.key);

  // Company / outlet scope: a record of another company or outlet is not this instance's.
  const company = scope.companyPath ? str(convert(getPath(raw, scope.companyPath), 'text')) : null;
  const outlet = scope.outletPath ? str(convert(getPath(raw, scope.outletPath), 'text')) : null;
  if (scope.companyValue && company !== scope.companyValue) return { ok: 'out_of_scope' };
  if (scope.outletValue && outlet !== scope.outletValue) return { ok: 'out_of_scope' };

  let lines: Record<string, string | number | boolean | undefined>[] = [];
  if (spec.line.length > 0) {
    const rawLines = getPath(raw, config.linesPath);
    if (!Array.isArray(rawLines) || rawLines.length === 0) bad.push('lines');
    else
      lines = rawLines.map((rl, i) => {
        const l = readFields(rl, spec.line, config.lineFields, bad, `lines.${String(i + 1)}.`);
        for (const s of spec.line)
          if (
            s.required &&
            l[s.key] === undefined &&
            !bad.includes(`lines.${String(i + 1)}.${s.key}`)
          )
            bad.push(`lines.${String(i + 1)}.${s.key}`);
        const groups = new Set(spec.line.flatMap((s) => (s.oneOf ? [s.oneOf] : [])));
        for (const g of groups)
          if (!spec.line.some((s) => s.oneOf === g && l[s.key] !== undefined))
            bad.push(`lines.${String(i + 1)}.${g}`);
        return l;
      });
  }

  const erpId = str(h.id);
  if (erpId !== null && erpId.length > 128) bad.push('id');
  if (bad.length > 0 || erpId === null)
    return {
      ok: false,
      invalid: { erpId: erpId && erpId.length <= 128 ? erpId : null, fields: [...new Set(bad)] },
    };

  const doc = buildDoc(entity, h, lines);
  return {
    ok: true,
    record: {
      erpId,
      doc: doc as DocOf[E],
      sourceUpdatedAt: updatedAtIso(h.updatedAt),
      company,
      outlet,
      rawHash: hashRaw({ raw, mapping: mappingHash(config, scope) }),
    },
  };
}

function buildDoc(
  entity: Entity,
  h: Record<string, string | number | boolean | undefined>,
  lines: Record<string, string | number | boolean | undefined>[],
): DocOf[Entity] {
  const status = (v: unknown, yes: string, no: string) =>
    v === true ? yes : v === false ? no : null;
  switch (entity) {
    case 'vendors':
      return {
        code: str(h.code),
        name: str(h.name) ?? '',
        gstin: str(h.gstin)?.toUpperCase() ?? null,
        address: str(h.address),
        status: status(h.status, 'active', 'inactive') as VendorDoc['status'],
      };
    case 'items':
      return {
        code: str(h.code),
        name: str(h.name) ?? '',
        hsnSac: str(h.hsnSac)?.replace(/\s+/g, '') ?? null,
        uom: str(h.uom),
        gstRateBp: num(h.gstRateBp),
      };
    case 'purchase_orders':
      return {
        poNumber: str(h.poNumber) ?? '',
        vendorRef: str(h.vendorRef) ?? '',
        poDate: str(h.poDate) ?? '',
        status: status(h.status, 'open', 'closed') as PoDoc['status'],
        lines: lines.map((l) => ({
          lineRef: str(l.lineRef),
          lineNo:
            l.lineNo === undefined
              ? null
              : Number.isInteger(Number(l.lineNo))
                ? Number(l.lineNo)
                : null,
          itemRef: str(l.itemRef) ?? '',
          qtyMilli: num(l.qtyMilli) ?? 0,
          unitPricePaise: num(l.unitPricePaise) ?? 0,
          gstRateBp: num(l.gstRateBp),
        })),
      };
    case 'grns':
      return {
        grnNumber: str(h.grnNumber) ?? '',
        poRef: str(h.poRef) ?? '',
        grnDate: str(h.grnDate) ?? '',
        lines: lines.map((l) => ({
          poLineRef: str(l.poLineRef),
          itemRef: str(l.itemRef),
          receivedQtyMilli: num(l.receivedQtyMilli),
          acceptedQtyMilli: num(l.acceptedQtyMilli) ?? 0,
        })),
      };
    case 'bills':
      return {
        billNumber: str(h.billNumber) ?? '',
        vendorRef: str(h.vendorRef) ?? '',
        billDate: str(h.billDate) ?? '',
        totalPaise: num(h.totalPaise),
        poRef: str(h.poRef),
        paymentStatus: str(h.paymentStatus),
      };
  }
}
