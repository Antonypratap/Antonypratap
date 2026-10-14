/**
 * What is removed from a reading when its original document is deleted (docs/SECURITY.md,
 * "Deletion"): the text quoted from the page as evidence, and the other values printed on the
 * invoice (IRN, bank details, addresses…). Kept: every value Veyrafy compared and the decisions
 * made on them, so the invoice record and its audit trail stay exactly as they were. Freight-like
 * printed values stay too, because the comparison reads them.
 */

const FREIGHT = /freight|cartage|carriage|transport/i;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Blanks the quoted text in every `evidence` object (positions stay). Returns how many. */
function blankEvidence(value: Json): number {
  let n = 0;
  if (Array.isArray(value)) {
    for (const v of value) n += blankEvidence(v);
    return n;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'evidence' && v && typeof v === 'object' && !Array.isArray(v)) {
        if (typeof v.text === 'string' && v.text !== '') {
          v.text = '';
          n++;
        }
      } else n += blankEvidence(v);
    }
  }
  return n;
}

/** The stored reading with printed text removed (see above). */
export function redactReading(rawJson: string): { json: string; removed: number } {
  const raw = JSON.parse(rawJson) as Json;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { json: rawJson, removed: 0 };
  let removed = 0;
  const other = raw.otherFields;
  if (Array.isArray(other)) {
    const kept = other.filter(
      (o) =>
        !!o &&
        typeof o === 'object' &&
        !Array.isArray(o) &&
        typeof o.label === 'string' &&
        FREIGHT.test(o.label),
    );
    removed += other.length - kept.length;
    raw.otherFields = kept;
  }
  removed += blankEvidence(raw);
  raw.contentsRemoved = true;
  return { json: JSON.stringify(raw), removed };
}

/** A stored field's evidence with its quoted text removed (page and position stay). */
export function redactEvidence(evidenceJson: string | null): string | null {
  if (!evidenceJson) return evidenceJson;
  const e = JSON.parse(evidenceJson) as Json;
  if (e && typeof e === 'object' && !Array.isArray(e) && typeof e.text === 'string') e.text = '';
  return JSON.stringify(e);
}
