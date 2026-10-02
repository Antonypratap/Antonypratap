import type { Grn, Item, PoLine, PurchaseOrder, Vendor } from '@veyra/erp-connector';
import {
  formatInr,
  formatQty,
  formatRate,
  milliQty,
  paise,
  rateBp,
  type ApiComparison,
  type ValidationOutcome,
} from '@veyra/shared';
import { lineTaxableAmount } from '@veyra/india-tax';
import { dateText } from '../engine/questions';

/**
 * The invoice compared with the ERP, value by value (the invoice screen's ✓ / ✗ table).
 *
 * Nothing here decides anything: every ✓ or ✗ is the outcome of a check the engine actually ran
 * on the latest run (docs/RULES.md §3), and every value is what was read or what the ERP holds.
 * A row whose checks did not run says so ("not checked") instead of showing a tick.
 */
export interface ComparisonCheck {
  rule: string;
  lineNo: number | null;
  outcome: ValidationOutcome;
  naReason: string | null;
  message: string;
}

export interface ComparisonLine {
  lineNo: number;
  description: string | null;
  hsnSac: string | null;
  uom: string | null;
  qtyMilli: number | null;
  unitPricePaise: number | null;
  taxablePaise: number | null;
  gstRateBp: number | null;
  item: Item | null;
  poLine: PoLine | null;
  /** Accepted on the ERP's goods receipts for this order line; null when not linked. */
  acceptedMilli: number | null;
}

export interface ComparisonInput {
  /** Whether the invoice is cleared (verified, or being recorded after every check passed). */
  cleared: boolean;
  checks: readonly ComparisonCheck[];
  header: {
    vendorName: string | null;
    vendorGstin: string | null;
    buyerGstin: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    poNumber: string | null;
    taxablePaise: number | null;
    cgstPaise: number | null;
    sgstPaise: number | null;
    igstPaise: number | null;
    roundOffPaise: number | null;
    totalPaise: number | null;
  };
  companyGstin: string;
  vendor: Vendor | null;
  po: PurchaseOrder | null;
  poVendorName: string | null;
  grns: readonly Grn[];
  lines: readonly ComparisonLine[];
}

type Row = ApiComparison['rows'][number];

const money = (p: number | null): string | null => (p === null ? null : formatInr(paise(p)));
const qty = (m: number | null, uom: string | null): string | null =>
  m === null ? null : `${formatQty(milliQty(m))}${uom ? ` ${uom}` : ''}`;
const rate = (bp: number | null): string | null => (bp === null ? null : formatRate(rateBp(bp)));
const same = (a: string | null, b: string | null): boolean =>
  a !== null &&
  b !== null &&
  a.replace(/\s+/g, '').toUpperCase() === b.replace(/\s+/g, '').toUpperCase();

export function buildComparison(x: ComparisonInput): ApiComparison | null {
  if (x.checks.length === 0) return null;
  const rows: Row[] = [];

  /** The outcome of the given checks (for one line, or the invoice as a whole). */
  const judge = (rules: readonly string[], lineNo: number | null): Pick<Row, 'result' | 'note'> => {
    // A line row uses the line's own results; a rule recorded once for the whole invoice (for
    // example "every line has an item") applies to each line.
    const relevant = rules.flatMap((rule) => {
      const own = x.checks.filter((c) => c.rule === rule && c.lineNo === lineNo);
      return own.length || lineNo === null
        ? own
        : x.checks.filter((c) => c.rule === rule && c.lineNo === null);
    });
    const failed = relevant.filter((c) => c.outcome === 'fail');
    if (failed.length) return { result: 'mismatch', note: failed.map((c) => c.message).join(' ') };
    if (relevant.some((c) => c.outcome === 'pass')) return { result: 'match', note: null };
    const why = relevant.find((c) => c.naReason)?.naReason ?? null;
    return { result: 'not_checked', note: why ? naText(why) : 'Not checked yet.' };
  };
  const add = (
    section: string,
    label: string,
    invoice: string | null,
    erp: string | null,
    rules: readonly string[],
    lineNo: number | null = null,
    /** Two identifiers that must be the same value: a difference is a mismatch whatever ran. */
    mustEqual = false,
  ) => {
    let verdict = judge(rules, lineNo);
    if (mustEqual && invoice !== null && erp !== null && !same(invoice, erp))
      verdict = { result: 'mismatch', note: verdict.note ?? 'The invoice and the ERP differ.' };
    rows.push({ section, label, invoice, erp, ...verdict });
  };

  const h = x.header;
  // The invoice itself.
  add('Invoice', 'All required values read', null, null, ['R01']);
  add(
    'Invoice',
    'Not already recorded',
    h.invoiceNumber,
    x.checks.some((c) => c.rule === 'R11' && c.outcome === 'pass')
      ? 'No earlier invoice with this number'
      : null,
    ['R11'],
  );
  add(
    'Invoice',
    'Invoice date',
    h.invoiceDate,
    x.po ? `On or after the order date (${dateText(x.po.poDate)})` : null,
    ['R05', 'R24'],
  );

  // Supplier and buyer.
  add('Supplier', 'Name', h.vendorName, x.vendor?.name ?? null, ['R12']);
  add('Supplier', 'GSTIN', h.vendorGstin, x.vendor?.gstin ?? null, ['R12'], null, true);
  add(
    'Supplier',
    'Active in your ERP',
    null,
    x.vendor ? (x.vendor.status === 'active' ? 'Active' : 'Inactive') : null,
    ['R13'],
  );
  add('You', 'Your GSTIN on the invoice', h.buyerGstin, x.companyGstin, ['R04'], null, true);

  // Purchase order and goods receipt.
  add('Purchase order', 'Order number', h.poNumber, x.po?.poNumber ?? null, ['R17'], null, true);
  add('Purchase order', 'Order belongs to this supplier', h.vendorName, x.poVendorName, ['R18']);
  add(
    'Purchase order',
    'Order is open',
    null,
    x.po ? (x.po.status === 'open' ? 'Open' : 'Closed') : null,
    ['R19'],
  );
  add(
    'Goods receipt',
    'Goods received',
    null,
    x.po
      ? x.grns.map((g) => `${g.grnNumber} (${dateText(g.grnDate)})`).join(', ') || 'None recorded'
      : null,
    ['R25'],
  );

  // Every line.
  for (const l of x.lines) {
    const section = `Line ${l.lineNo}${l.description ? ` · ${l.description}` : ''}`;
    add(
      section,
      'Item',
      l.description,
      l.item ? `${l.item.name} (${l.item.code})` : null,
      ['R14', 'R20'],
      l.lineNo,
    );
    add(section, 'HSN/SAC', l.hsnSac, l.item?.hsnSac ?? null, ['R15'], l.lineNo, true);
    add(section, 'Unit', l.uom, l.item?.uom ?? null, ['R27'], l.lineNo, true);
    add(
      section,
      'Quantity',
      qty(l.qtyMilli, l.uom),
      l.poLine
        ? `Ordered ${qty(l.poLine.qtyMilli, l.item?.uom ?? null)}${
            l.acceptedMilli === null
              ? ''
              : ` · received ${qty(l.acceptedMilli, l.item?.uom ?? null)}`
          }`
        : null,
      ['R23', 'R26'],
      l.lineNo,
    );
    add(
      section,
      'Rate',
      money(l.unitPricePaise),
      money(l.poLine?.unitPricePaise ?? null),
      ['R21'],
      l.lineNo,
    );
    add(
      section,
      'GST rate',
      rate(l.gstRateBp),
      rate(l.poLine?.gstRateBp ?? l.item?.gstRateBp ?? null),
      ['R16', 'R22'],
      l.lineNo,
    );
    add(
      section,
      'Amount (quantity × rate)',
      money(l.taxablePaise),
      l.qtyMilli !== null && l.unitPricePaise !== null
        ? money(lineTaxableAmount(milliQty(l.qtyMilli), paise(l.unitPricePaise)))
        : null,
      ['R06'],
      l.lineNo,
    );
  }

  // Totals: the invoice's own arithmetic.
  const lineSum = x.lines.every((l) => l.taxablePaise !== null)
    ? x.lines.reduce((s, l) => s + (l.taxablePaise ?? 0), 0)
    : null;
  add('Totals', 'Taxable value (sum of lines)', money(h.taxablePaise), money(lineSum), ['R09']);
  for (const [label, value] of [
    ['CGST', h.cgstPaise],
    ['SGST', h.sgstPaise],
    ['IGST', h.igstPaise],
  ] as const)
    if (value !== null && value !== 0)
      add('Totals', label, money(value), 'Tax on the lines at their GST rates', ['R07', 'R08']);
  if (h.roundOffPaise !== null && h.roundOffPaise !== 0)
    add('Totals', 'Round off', money(h.roundOffPaise), 'Rounding to the rupee', ['R10']);
  const calculated =
    h.taxablePaise === null
      ? null
      : h.taxablePaise +
        (h.cgstPaise ?? 0) +
        (h.sgstPaise ?? 0) +
        (h.igstPaise ?? 0) +
        (h.roundOffPaise ?? 0);
  add('Totals', 'Invoice total', money(h.totalPaise), money(calculated), ['R09']);

  const mismatches = rows.filter((r) => r.result === 'mismatch');
  const notChecked = rows.filter((r) => r.result === 'not_checked').length;
  const matched = rows.filter((r) => r.result === 'match').length;
  const verdict: ApiComparison['verdict'] = mismatches.length
    ? 'mismatch'
    : x.cleared
      ? 'cleared'
      : 'incomplete';
  const describe = (r: Row) =>
    `${r.section} – ${r.label}: invoice ${r.invoice ?? 'not read'}, ERP ${r.erp ?? 'none'}`;
  const summary =
    verdict === 'mismatch'
      ? `Does not match the ERP. ${mismatches.map(describe).join('; ')}.`
      : verdict === 'cleared'
        ? `Every value matches the ERP${x.po ? ` (order ${x.po.poNumber}` : ''}${
            x.po && x.grns.length ? `, receipt ${x.grns.map((g) => g.grnNumber).join(', ')}` : ''
          }${x.po ? ')' : ''}${h.totalPaise !== null ? `; total ${money(h.totalPaise)}` : ''}.`
        : `${notChecked} value${notChecked === 1 ? '' : 's'} still to be confirmed before this invoice can be cleared.`;
  return {
    verdict,
    headline:
      verdict === 'cleared'
        ? 'Cleared: every value matches your ERP'
        : verdict === 'mismatch'
          ? `${mismatches.length} value${mismatches.length === 1 ? ' does' : 's do'} not match your ERP`
          : 'Not cleared yet',
    summary,
    matched,
    mismatched: mismatches.length,
    notChecked,
    rows,
  };
}

/** Why a check did not apply, in words (RULES §3 not-applicable reasons). */
function naText(reason: string): string {
  const known: Record<string, string> = {
    PO_DERIVED_FROM_INVOICE:
      'The order is being created from this invoice, so there is nothing to compare.',
    NO_ROUND_OFF_LINE: 'No round-off on the invoice.',
  };
  return known[reason] ?? 'Not applicable to this invoice.';
}
