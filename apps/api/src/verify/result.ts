import type { ComparisonRow, InvoiceSide } from '../workflow/erp-receipts';

/**
 * The verification API's result (docs/VERIFY-API.md), from the comparison of the invoice as Veyrafy
 * read it with the client's reference record (`receiptComparison`, the same logic as the product's
 * receipt check).
 *
 * Outcomes:
 * - FAILED: at least one check definitively failed (a value differs, or an item is on one side only).
 * - REVIEW_REQUIRED: nothing failed, but a required value was not read with certainty, is
 *   ambiguous, or could not be compared.
 * - PASSED: every required check passed. Never returned while any check is unresolved, and only
 *   when the supplier, the invoice number and the total were each read and matched.
 *
 * Scope: this compares the invoice with the reference only. It does not match purchase orders or
 * goods receipts in Veyrafy, look for duplicates, or establish supplier authenticity, GST compliance
 * or payment authorisation.
 */

export type Outcome = 'PASSED' | 'FAILED' | 'REVIEW_REQUIRED';
export const SCOPE = 'invoice_vs_reference' as const;

export interface Check {
  id: string;
  section: string;
  label: string;
  /** The invoice field compared (e.g. `header.totalPaise`, `lines[2].qtyMilli`), when one is. */
  field: string | null;
  result: 'passed' | 'failed' | 'unverified' | 'not_compared';
  invoice_value: string | null;
  reference_value: string | null;
  reason: string | null;
}

export interface FailedField {
  field: string;
  check_id: string;
  invoice_value: string | null;
  reference_value: string | null;
  /** Invoice minus reference, when both are amounts or quantities that were read. */
  difference: { value: string; unit: string } | null;
  reason: string;
}

export interface UnverifiedField {
  field: string;
  check_id: string;
  reason: string;
}

export interface VerificationOutcome {
  status: Outcome;
  review_required: boolean;
  scope: typeof SCOPE;
  checks: Check[];
  failed_fields: FailedField[];
  unverified_fields: UnverifiedField[];
}

/** Rows about finding a record or duplicates in Veyrafy: not part of this API's comparison. */
const OUT_OF_SCOPE = new Set(['ERP receipt']);

/** The fields that must each be read and matched before PASSED can be returned. */
const REQUIRED_MATCHED = ['header.vendorName', 'header.invoiceNumber', 'header.totalPaise'];

/** The product's wording ("the ERP") as this API's ("the reference"). */
function referenceWording(text: string | null): string | null {
  if (text === null) return null;
  return text
    .replace(/your ERP's code/g, "the reference's code")
    .replace(/\bERP receipt( GRN \S+)?/g, 'reference')
    .replace(/\b[Tt]he ERP record\b/g, 'The reference')
    .replace(/\b(the|your) ERP\b/g, 'the reference')
    .replace(/\b(The|Your) ERP\b/g, 'The reference')
    .replace(/\bin the ERP\b/g, 'in the reference')
    .replace(/\bERP\b/g, 'reference');
}

/**
 * A supplier name that reads like a registration or contact line ("MSME No: UDYAM-…", "PAN:
 * AAKCE…", a table rule "|"): the name was misread, so a difference is not proven.
 */
export function looksLikeLabel(name: string | null): boolean {
  if (name === null) return false;
  const t = name.trim();
  return (
    /^[|¦‖│┃:]/.test(t) ||
    /\b(msme|udyam|udyog|gstin|pan|cin|fssai|iec|tan|phone|ph|tel|mobile|mob|e-?mail)\b\s*(no\.?|number)?\s*[:-]/i.test(
      t,
    ) ||
    /^[^:]{0,30}\b(no|number|code|id)\.?\s*:/i.test(t) ||
    /\d{6,}/.test(t)
  );
}

const SELF_CHECK_FAILED =
  "The invoice's own figures do not add up as Veyrafy read them, so this may be a reading error rather than a real difference. Check it against the invoice.";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** "₹1,23,456.50" → paise; null when it is not exactly an amount. */
function moneyOf(text: string | null): number | null {
  const m = text === null ? null : /^₹\s?(-?)([\d,]+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const v = Number((m[2] ?? '').replace(/,/g, '')) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -v : v;
}
/** "1,000 NOS" / "2.5" → milli-units and unit; null when it is not exactly a quantity. */
function qtyOf(text: string | null): { milli: number; unit: string } | null {
  const m = text === null ? null : /^([\d,]+)(?:\.(\d{1,3}))?(?:\s+(\S+))?$/.exec(text.trim());
  if (!m) return null;
  return {
    milli: Number((m[1] ?? '').replace(/,/g, '')) * 1000 + Number((m[2] ?? '').padEnd(3, '0')),
    unit: m[3] ?? 'units',
  };
}
const decimal = (n: number, places: number) => {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const unit = 10 ** places;
  return `${sign}${Math.floor(a / unit)}.${String(a % unit).padStart(places, '0')}`;
};

function differenceOf(r: ComparisonRow, totalDeltaPaise: number | null): FailedField['difference'] {
  if (r.path === 'header.totalPaise' && r.label === 'Invoice total')
    return totalDeltaPaise === null ? null : { value: decimal(totalDeltaPaise, 2), unit: 'INR' };
  const a = moneyOf(r.invoice);
  const b = moneyOf(r.erp);
  if (a !== null && b !== null) return { value: decimal(a - b, 2), unit: 'INR' };
  if (r.label === 'Quantity') {
    const x = qtyOf(r.invoice);
    const y = qtyOf(r.erp);
    if (x && y && x.unit.toUpperCase() === y.unit.toUpperCase())
      return { value: decimal(x.milli - y.milli, 3), unit: x.unit.toUpperCase() };
  }
  return null;
}

export function verificationOutcome(
  rows: readonly ComparisonRow[],
  inv: InvoiceSide,
  totalDeltaPaise: number | null,
): VerificationOutcome {
  // When the invoice disagrees with itself as read (its lines, tax and total do not add up), a
  // difference in its figures may be a misreading: asked, never reported as a proven failure.
  // The tax heads are checked too, as GST allows: CGST and SGST are always equal, and no head can be
  // more than its highest rate (14%, or 28% for IGST) of the invoice total, which includes it.
  const total = inv.totalPaise;
  const taxImpossible =
    (inv.cgstPaise !== null && inv.sgstPaise !== null && inv.cgstPaise !== inv.sgstPaise) ||
    (total !== null &&
      total > 0 &&
      ((inv.cgstPaise ?? 0) > total * 0.14 ||
        (inv.sgstPaise ?? 0) > total * 0.14 ||
        (inv.igstPaise ?? 0) > total * 0.28));
  const selfInconsistent =
    taxImpossible ||
    rows.some((r) => r.section === 'Invoice arithmetic' && r.result === 'mismatch');
  const nameMisread = looksLikeLabel(inv.vendorName);
  const used = new Map<string, number>();
  const checks: (Check & { row: ComparisonRow })[] = [];
  for (const r of rows) {
    if (OUT_OF_SCOPE.has(r.section)) continue;
    let result: Check['result'] =
      r.result === 'match'
        ? 'passed'
        : r.result === 'mismatch' || r.result === 'unmatched'
          ? 'failed'
          : r.result === 'needs_confirmation'
            ? 'unverified'
            : 'not_compared';
    let reason = referenceWording(r.note);
    // No item line read at all: a reference item "missing from the invoice" is a reading gap to
    // review, never a proven difference.
    if (inv.lines.length === 0 && r.label === 'Item' && r.invoice === null && result === 'failed') {
      result = 'unverified';
      reason =
        'No item lines were read on the invoice with certainty, so the items could not be compared.';
    }
    if (
      result === 'failed' &&
      selfInconsistent &&
      (r.section === 'Invoice arithmetic' || r.section === 'Totals')
    ) {
      result = 'unverified';
      reason = SELF_CHECK_FAILED;
    }
    if (
      result === 'failed' &&
      nameMisread &&
      r.path === 'header.vendorName' &&
      r.label === 'Name'
    ) {
      result = 'unverified';
      reason =
        'The supplier name read looks like a registration or contact line, not a name, so it could not be compared. Check it against the invoice.';
    }
    const section = referenceWording(r.section) ?? r.section;
    const label = referenceWording(r.label) ?? r.label;
    const base = slug(`${section}_${label}`);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    checks.push({
      id: n === 1 ? base : `${base}_${n}`,
      section,
      label,
      field: r.path ?? null,
      result,
      invoice_value: r.invoice,
      reference_value: r.erp,
      reason,
      row: r,
    });
  }

  // A required value that is not read and matched is never left out silently.
  for (const path of REQUIRED_MATCHED)
    if (!checks.some((c) => c.field === path && c.result === 'passed')) {
      const has = checks.some((c) => c.field === path && c.result !== 'not_compared');
      if (!has)
        checks.push({
          id: slug(`required_${path}`),
          section: 'Required',
          label: path,
          field: path,
          result: 'unverified',
          invoice_value: null,
          reference_value: null,
          reason: 'A required value could not be read and compared.',
          row: {
            section: 'Required',
            label: path,
            invoice: null,
            erp: null,
            result: 'needs_confirmation',
            note: null,
          },
        });
    }

  const failed = checks.filter((c) => c.result === 'failed');
  const unverified = checks.filter((c) => c.result === 'unverified');
  const requiredMatched = REQUIRED_MATCHED.every((p) =>
    checks.some((c) => c.field === p && c.result === 'passed'),
  );
  const status: Outcome =
    failed.length > 0
      ? 'FAILED'
      : unverified.length > 0 || !requiredMatched
        ? 'REVIEW_REQUIRED'
        : 'PASSED';
  // The guarantee, checked again: PASSED never carries an unresolved or failed check.
  if (status === 'PASSED' && (failed.length > 0 || unverified.length > 0))
    throw new Error('A verification cannot pass with unresolved checks.');

  return {
    status,
    review_required: unverified.length > 0 || status === 'REVIEW_REQUIRED',
    scope: SCOPE,
    checks: checks.map((c) => ({
      id: c.id,
      section: c.section,
      label: c.label,
      field: c.field,
      result: c.result,
      invoice_value: c.invoice_value,
      reference_value: c.reference_value,
      reason: c.reason,
    })),
    failed_fields: failed.map((c) => ({
      field: c.field ?? `${c.section} / ${c.label}`,
      check_id: c.id,
      invoice_value: c.invoice_value,
      reference_value: c.reference_value,
      difference: differenceOf(c.row, totalDeltaPaise),
      reason: c.reason ?? 'The invoice and the reference differ.',
    })),
    unverified_fields: unverified.map((c) => ({
      field: c.field ?? `${c.section} / ${c.label}`,
      check_id: c.id,
      reason: c.reason ?? 'Not read with certainty.',
    })),
  };
}
