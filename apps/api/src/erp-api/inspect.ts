import { getPath, mapRecord } from './mapping';
import { FIELDS, type Entity, type EntityConfig, type FieldMapping, type Profile } from './profile';

/**
 * The mapping step's help: what an ERP's answer looks like (where the list of records is, which
 * fields it has, a few sample values), a proposed mapping from field names, and a preview of the
 * first records in Veyrafy's form with what failed. Sample values are shown only to the admin
 * setting up the connection (their own data); none of it is stored or logged.
 */

export interface FieldFound {
  path: string;
  samples: string[];
}

export interface Inspection {
  /** Where the list of records is ('' when the answer is the list itself); null when none found. */
  listPath: string | null;
  received: number;
  fields: FieldFound[];
  /** For orders and receipts: where the lines are, and their fields. */
  linesPath: string | null;
  lineFields: FieldFound[];
}

const MAX_SAMPLES = 3;

/** Finds the list of records: the answer itself, or the first array of objects under it (2 levels). */
export function findList(body: unknown): string | null {
  const isList = (v: unknown) => Array.isArray(v) && (v.length === 0 || typeof v[0] === 'object');
  if (isList(body)) return '';
  if (!body || typeof body !== 'object') return null;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (isList(v)) return k;
    if (v && typeof v === 'object' && !Array.isArray(v))
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>))
        if (isList(v2)) return `${k}.${k2}`;
  }
  return null;
}

function show(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** The scalar fields of records (dotted paths, nested objects flattened), with sample values. */
function scalarFields(records: unknown[]): { fields: FieldFound[]; arrays: string[] } {
  const found = new Map<string, string[]>();
  const arrays = new Set<string>();
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 3) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(x)) {
        if (x.length > 0 && typeof x[0] === 'object') arrays.add(path);
      } else if (x && typeof x === 'object') walk(x, path, depth + 1);
      else if (x !== null && x !== undefined && x !== '') {
        const list = found.get(path) ?? [];
        if (list.length < MAX_SAMPLES && !list.includes(show(x))) list.push(show(x));
        found.set(path, list);
      } else if (!found.has(path)) found.set(path, []);
    }
  };
  for (const r of records.slice(0, 20)) walk(r, '', 0);
  return { fields: [...found].map(([path, samples]) => ({ path, samples })), arrays: [...arrays] };
}

export function inspectAnswer(body: unknown, listPath?: string): Inspection {
  const where = listPath ?? findList(body);
  const list = where === null ? null : getPath(body, where || undefined);
  if (!Array.isArray(list))
    return { listPath: null, received: 0, fields: [], linesPath: null, lineFields: [] };
  const { fields, arrays } = scalarFields(list);
  const linesPath = arrays[0] ?? null;
  const lines = linesPath
    ? list.flatMap((r) => {
        const l = getPath(r, linesPath);
        return Array.isArray(l) ? l : [];
      })
    : [];
  return {
    listPath: where,
    received: list.length,
    fields,
    linesPath,
    lineFields: scalarFields(lines).fields,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const last = (path: string) => path.split('.').pop() ?? path;

/** Proposes a field for each Veyrafy field by name: an exact hint first, then a containing one. */
export function proposeFields(
  entity: Entity,
  found: FieldFound[],
  part: 'header' | 'line',
): Record<string, FieldMapping> {
  const out: Record<string, FieldMapping> = {};
  const taken = new Set<string>();
  const specs = FIELDS[entity][part];
  for (const pass of ['exact', 'contains'] as const)
    for (const spec of specs) {
      if (out[spec.key]) continue;
      const hints = spec.hints.map(norm);
      const match = found.find((f) => {
        if (taken.has(f.path) && spec.key !== 'code') return false;
        const n = norm(last(f.path));
        return pass === 'exact'
          ? hints.includes(n)
          : hints.some((h) => h.length > 3 && n.includes(h));
      });
      if (match) {
        out[spec.key] = { path: match.path };
        taken.add(match.path);
      }
    }
  return out;
}

/** The first records in Veyrafy's form, through the given mapping, with what failed. */
export function previewRecords(
  entity: Entity,
  body: unknown,
  config: EntityConfig,
  scope: Profile['scope'],
  max = 5,
) {
  const list = getPath(body, config.listPath || undefined);
  if (!Array.isArray(list)) return [];
  return list.slice(0, max).map((raw) => {
    const r = mapRecord(entity, raw, config, scope);
    if (r.ok === true) return { ok: true as const, erpId: r.record.erpId, record: r.record.doc };
    if (r.ok === false)
      return { ok: false as const, erpId: r.invalid.erpId, fields: r.invalid.fields };
    return { ok: false as const, erpId: null, fields: ['outOfScope'] };
  });
}
