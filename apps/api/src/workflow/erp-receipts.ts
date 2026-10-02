import { z } from 'zod';
import {
  formatInr,
  formatQty,
  milliQty,
  normalizeInvoiceNumber,
  paise,
  type ApiComparison,
} from '@veyra/shared';
import { dateText } from '../engine/questions';

/**
 * The receipt check: an invoice compared with the goods-receipt record the business's own ERP
 * exported for it (its JSON API: `{ data: [{ invoice_info, items, images }] }`).
 *
 * The ERP record is matched by the supplier's invoice number (`dc_no`) and the supplier's name.
 * Every value is then compared as printed against the ERP's value; a value Veyrafy could not read
 * with certainty, or one the ERP does not hold, is never shown as a match. Nothing is guessed:
 * charge codes are mapped by the fixed table below, and an unknown code is shown as such.
 */

/** The ERP export's charge codes: tax heads and freight. Anything else is "other". */
export const CHARGE_CODES: Readonly<Record<string, 'cgst' | 'sgst' | 'igst' | 'freight'>> = {
  GTC0000001: 'cgst',
  GTC0000002: 'sgst',
  GTC0000004: 'igst',
  FRTWITHGST: 'freight',
};

const Num = z.union([z.number(), z.string()]).nullable().optional();
const ItemSchema = z
  .object({
    item_name: z.string().min(1),
    hsn_sac_code: z.union([z.string(), z.number()]).nullable().optional(),
    uom: z.string().nullable().optional(),
    quantity: Num,
    basic_rate: Num,
    basic_amount: Num,
    discount: Num,
    cgst: Num,
    sgst: Num,
    igst: Num,
    freight: Num,
    other_charges: z
      .array(z.object({ code: z.string(), value: Num }).loose())
      .nullable()
      .optional(),
  })
  .loose();
const RecordSchema = z
  .object({
    invoice_info: z
      .object({
        grn_id: z.coerce.string(),
        grn_no: z.coerce.string(),
        po_id: z.coerce.string().nullable().optional(),
        dc_no: z.coerce.string().min(1),
        grn_date: z.string().nullable().optional(),
        invoice_date: z.string().nullable().optional(),
        invoice_amount: Num,
        vendor_name: z.string().min(1),
        vendor_code: z.string().nullable().optional(),
      })
      .loose(),
    items: z.array(ItemSchema).min(1),
    images: z
      .array(z.object({ file_name: z.string(), mime_type: z.string(), base64: z.string() }).loose())
      .nullable()
      .optional(),
  })
  .loose();
export const ReceiptFileSchema = z.object({ data: z.array(RecordSchema).min(1) }).loose();
export type RawReceiptRecord = z.infer<typeof RecordSchema>;

export interface ReceiptLine {
  name: string;
  hsn: string | null;
  uom: string | null;
  qtyMilli: number | null;
  ratePaise: number | null;
  amountPaise: number | null;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  freightPaise: number;
  /** Charges with a code not in CHARGE_CODES (kept, shown, counted in the total). */
  other: { code: string; paise: number }[];
}

export interface ReceiptRecord {
  grnNo: string;
  grnDate: string | null;
  poRef: string | null;
  invoiceNo: string;
  erpInvoiceDate: string | null;
  erpInvoiceAmountPaise: number | null;
  vendorName: string;
  vendorCode: string | null;
  lines: ReceiptLine[];
}

/** A decimal amount ("1834.59", 24480) to paise, exactly; null when it is not one. */
export function toPaise(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().replace(/,/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const value = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -value : value;
}
/** A quantity ("16000", 2415.5) to milli-units, exactly; null when it is not one. */
function toMilli(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(v).trim().replace(/,/g, ''));
  return m ? Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0')) : null;
}
/** "04/12/2025" (day first, as the ERP writes it) or "2025-12-04" to an ISO date. */
function toIsoDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v.trim());
  return dmy ? `${dmy[3]}-${dmy[2]?.padStart(2, '0')}-${dmy[1]?.padStart(2, '0')}` : null;
}

export function normalizeReceipt(raw: RawReceiptRecord): ReceiptRecord {
  const info = raw.invoice_info;
  return {
    grnNo: info.grn_no,
    grnDate: toIsoDate(info.grn_date),
    poRef: info.po_id ?? null,
    invoiceNo: info.dc_no.trim(),
    erpInvoiceDate: toIsoDate(info.invoice_date),
    erpInvoiceAmountPaise: toPaise(info.invoice_amount),
    vendorName: info.vendor_name.trim(),
    vendorCode: info.vendor_code ?? null,
    lines: raw.items.map((it) => {
      const line: ReceiptLine = {
        name: it.item_name.trim(),
        hsn:
          it.hsn_sac_code === null || it.hsn_sac_code === undefined
            ? null
            : String(it.hsn_sac_code),
        uom: it.uom ?? null,
        qtyMilli: toMilli(it.quantity),
        ratePaise: toPaise(it.basic_rate),
        amountPaise: toPaise(it.basic_amount),
        cgstPaise: toPaise(it.cgst) ?? 0,
        sgstPaise: toPaise(it.sgst) ?? 0,
        igstPaise: toPaise(it.igst) ?? 0,
        freightPaise: toPaise(it.freight) ?? 0,
        other: [],
      };
      for (const c of it.other_charges ?? []) {
        const value = toPaise(c.value) ?? 0;
        const head = CHARGE_CODES[c.code.trim().toUpperCase()];
        if (head === 'freight') line.freightPaise += value;
        else if (head) line[`${head}Paise`] += value;
        else line.other.push({ code: c.code, paise: value });
      }
      return line;
    }),
  };
}

export const invoiceNoKey = (invoiceNo: string): string => normalizeInvoiceNumber(invoiceNo);

const STOP = new Set(['pvt', 'ltd', 'private', 'limited', 'co', 'the', 'and', 'fy', 'm', 's']);
const tokens = (s: string): Set<string> =>
  new Set(
    s
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t && !STOP.has(t) && !/^\d{2,4}$/.test(t)),
  );
const subset = (a: Set<string>, b: Set<string>) => a.size > 0 && [...a].every((t) => b.has(t));
/** Two names are the same when every word of one appears in the other (case, punctuation and
 *  "Pvt Ltd"-style words ignored). "176x89mm" and "175x89mm" are different words. */
export function sameName(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ta = tokens(a);
  const tb = tokens(b);
  return subset(ta, tb) || subset(tb, ta);
}
const similarity = (a: string | null, b: string | null): number => {
  if (!a || !b) return 0;
  const ta = tokens(a);
  const tb = tokens(b);
  const common = [...ta].filter((t) => tb.has(t)).length;
  return common / Math.max(1, new Set([...ta, ...tb]).size);
};

/** The ERP record an invoice belongs to: same invoice number, and the same supplier if read. */
export function pickRecord<T extends { record: ReceiptRecord }>(
  candidates: readonly T[],
  vendorName: string | null,
): T | null {
  const fits = vendorName
    ? candidates.filter((c) => sameName(c.record.vendorName, vendorName))
    : [...candidates];
  return fits.at(-1) ?? null;
}

/** What the invoice says, as Veyrafy read it (null: not read with certainty). */
export interface InvoiceSide {
  vendorName: string | null;
  vendorGstin: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  poNumber: string | null;
  cgstPaise: number | null;
  sgstPaise: number | null;
  igstPaise: number | null;
  roundOffPaise: number | null;
  totalPaise: number | null;
  /** Freight or other charges printed outside the item lines, as read. */
  freightPaise: number | null;
  lines: {
    lineNo: number;
    description: string | null;
    hsnSac: string | null;
    uom: string | null;
    qtyMilli: number | null;
    unitPricePaise: number | null;
    taxablePaise: number | null;
  }[];
}

type Row = ApiComparison['rows'][number] & { blocking: boolean };
const money = (p: number | null) => (p === null ? null : formatInr(paise(p)));
const qty = (m: number | null, uom: string | null) =>
  m === null ? null : `${formatQty(milliQty(m))}${uom ? ` ${uom.toUpperCase()}` : ''}`;

export function compareWithReceipt(inv: InvoiceSide, erp: ReceiptRecord): ApiComparison {
  const rows: Row[] = [];
  const push = (r: Omit<Row, 'note'> & { note?: string | null }) => rows.push({ note: null, ...r });
  /** Compare two values: not read → not checked (blocking); ERP lacks it → not checked. */
  const cmp = (
    section: string,
    label: string,
    invoice: string | null,
    erpText: string | null,
    equal: boolean | null,
    note?: string,
  ) => {
    if (invoice === null)
      return push({
        section,
        label,
        invoice,
        erp: erpText,
        result: 'not_checked',
        blocking: true,
        note: 'Not read on the invoice with certainty.',
      });
    if (erpText === null || equal === null)
      return push({
        section,
        label,
        invoice,
        erp: erpText,
        result: 'not_checked',
        blocking: false,
        note: note ?? 'The ERP record does not hold this value.',
      });
    return push({
      section,
      label,
      invoice,
      erp: erpText,
      result: equal ? 'match' : 'mismatch',
      blocking: false,
      note: equal ? null : (note ?? 'The invoice and the ERP differ.'),
    });
  };

  // The record itself.
  push({
    section: 'ERP receipt',
    label: 'Matched ERP record',
    invoice: inv.invoiceNumber,
    erp: `GRN ${erp.grnNo}${erp.grnDate ? ` of ${dateText(erp.grnDate)}` : ''}`,
    result: 'match',
    blocking: false,
    note: 'Found by the supplier’s invoice number and name.',
  });

  // Supplier.
  cmp('Supplier', 'Name', inv.vendorName, erp.vendorName, sameName(inv.vendorName, erp.vendorName));
  cmp('Supplier', 'GSTIN', inv.vendorGstin, null, null, 'The ERP record carries no GSTIN.');

  // Invoice.
  cmp(
    'Invoice',
    'Invoice number',
    inv.invoiceNumber,
    erp.invoiceNo,
    inv.invoiceNumber !== null && invoiceNoKey(inv.invoiceNumber) === invoiceNoKey(erp.invoiceNo),
  );
  const recorded = erp.erpInvoiceAmountPaise !== null && erp.erpInvoiceAmountPaise > 0;
  cmp(
    'Invoice',
    'Invoice date',
    inv.invoiceDate ? dateText(inv.invoiceDate) : null,
    recorded && erp.erpInvoiceDate ? dateText(erp.erpInvoiceDate) : null,
    recorded ? inv.invoiceDate === erp.erpInvoiceDate : null,
    recorded
      ? undefined
      : `The ERP has not recorded this invoice yet (its invoice amount is 0)${erp.erpInvoiceDate ? `, so its date ${dateText(erp.erpInvoiceDate)} is not compared` : ''}.`,
  );
  cmp(
    'Purchase order',
    'Order',
    inv.poNumber,
    erp.poRef ? `ERP reference ${erp.poRef}` : null,
    null,
    'The ERP record holds its internal order id, not the order number printed on the invoice.',
  );

  // Lines: paired by item name, quantity and rate (the ERP may list them in another order).
  const pairs: { inv: InvoiceSide['lines'][number] | null; erp: ReceiptLine | null }[] = [];
  const freeInv = new Set(inv.lines.map((_, i) => i));
  const freeErp = new Set(erp.lines.map((_, i) => i));
  const scored: { i: number; e: number; s: number }[] = [];
  inv.lines.forEach((l, i) =>
    erp.lines.forEach((el, e) => {
      const s =
        similarity(l.description, el.name) +
        (l.qtyMilli !== null && l.qtyMilli === el.qtyMilli ? 1 : 0) +
        (l.unitPricePaise !== null && l.unitPricePaise === el.ratePaise ? 0.5 : 0);
      if (s > 0) scored.push({ i, e, s });
    }),
  );
  for (const { i, e } of scored.sort((a, b) => b.s - a.s))
    if (freeInv.has(i) && freeErp.has(e)) {
      freeInv.delete(i);
      freeErp.delete(e);
      pairs.push({ inv: inv.lines[i] ?? null, erp: erp.lines[e] ?? null });
    }
  for (const i of freeInv) pairs.push({ inv: inv.lines[i] ?? null, erp: null });
  for (const e of freeErp) pairs.push({ inv: null, erp: erp.lines[e] ?? null });
  pairs.sort((a, b) => (a.inv?.lineNo ?? 999) - (b.inv?.lineNo ?? 999));

  pairs.forEach((p, n) => {
    const section = `Line ${p.inv?.lineNo ?? n + 1} · ${p.erp?.name ?? p.inv?.description ?? ''}`;
    if (!p.erp || !p.inv) {
      push({
        section,
        label: 'Item',
        invoice: p.inv?.description ?? null,
        erp: p.erp?.name ?? null,
        result: 'mismatch',
        blocking: false,
        note: p.erp
          ? 'Received in the ERP, but not on the invoice.'
          : 'On the invoice, but not in the ERP receipt.',
      });
      return;
    }
    const l = p.inv;
    const e = p.erp;
    cmp(
      section,
      'Item',
      l.description,
      e.name,
      sameName(l.description, e.name),
      'The item names differ.',
    );
    cmp(section, 'HSN/SAC', l.hsnSac, e.hsn, e.hsn === null ? null : l.hsnSac === e.hsn);
    cmp(
      section,
      'Quantity',
      qty(l.qtyMilli, l.uom),
      qty(e.qtyMilli, e.uom),
      e.qtyMilli === null ? null : l.qtyMilli === e.qtyMilli,
      'Quantity received differs from the invoice.',
    );
    cmp(
      section,
      'Rate',
      money(l.unitPricePaise),
      money(e.ratePaise),
      e.ratePaise === null ? null : l.unitPricePaise === e.ratePaise,
      'Rate differs.',
    );
    cmp(
      section,
      'Amount',
      money(l.taxablePaise),
      money(e.amountPaise),
      e.amountPaise === null ? null : l.taxablePaise === e.amountPaise,
      'Amount differs.',
    );
  });

  // Charges and totals.
  const sum = (k: 'freightPaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'amountPaise') =>
    erp.lines.reduce((s, l) => s + (l[k] ?? 0), 0);
  const goods = sum('amountPaise');
  const invGoods = inv.lines.every((l) => l.taxablePaise !== null)
    ? inv.lines.reduce((s, l) => s + (l.taxablePaise ?? 0), 0)
    : null;
  cmp('Totals', 'Goods value (sum of lines)', money(invGoods), money(goods), invGoods === goods);
  const freight = sum('freightPaise');
  if (freight !== 0 || (inv.freightPaise ?? 0) !== 0)
    cmp('Totals', 'Freight', money(inv.freightPaise), money(freight), inv.freightPaise === freight);
  for (const [label, k, printed] of [
    ['CGST', 'cgstPaise', inv.cgstPaise],
    ['SGST', 'sgstPaise', inv.sgstPaise],
    ['IGST', 'igstPaise', inv.igstPaise],
  ] as const) {
    const erpTax = sum(k);
    if (erpTax === 0 && (printed ?? 0) === 0) continue;
    cmp('Totals', label, money(printed), money(erpTax), printed === erpTax);
  }
  const others = erp.lines.flatMap((l) => l.other);
  for (const code of [...new Set(others.map((o) => o.code))])
    push({
      section: 'Totals',
      label: `Other charge (your ERP's code ${code})`,
      invoice: null,
      erp: money(others.filter((o) => o.code === code).reduce((s, o) => s + o.paise, 0)),
      result: 'not_checked',
      blocking: true,
      note: "A charge in your ERP that Veyrafy doesn't recognise yet; it is included in the ERP total.",
    });
  const erpTotal =
    goods +
    freight +
    sum('cgstPaise') +
    sum('sgstPaise') +
    sum('igstPaise') +
    others.reduce((s, o) => s + o.paise, 0);
  const beforeRounding = inv.totalPaise === null ? null : inv.totalPaise - (inv.roundOffPaise ?? 0);
  cmp(
    'Totals',
    'Invoice total',
    money(inv.totalPaise),
    `${money(erpTotal)}${inv.roundOffPaise ? ` (invoice rounds by ${money(inv.roundOffPaise)})` : ''}`,
    beforeRounding === erpTotal,
    'The invoice total differs from the ERP receipt’s total.',
  );
  cmp(
    'Totals',
    'Invoice amount recorded in the ERP',
    money(inv.totalPaise),
    recorded ? money(erp.erpInvoiceAmountPaise) : null,
    recorded ? inv.totalPaise === erp.erpInvoiceAmountPaise : null,
    recorded ? undefined : 'The ERP has not recorded the invoice amount yet (it is 0).',
  );

  const mismatches = rows.filter((r) => r.result === 'mismatch');
  const blocking = rows.filter((r) => r.result === 'not_checked' && r.blocking);
  const verdict: ApiComparison['verdict'] = mismatches.length
    ? 'mismatch'
    : blocking.length
      ? 'incomplete'
      : 'cleared';
  const describe = (r: Row) =>
    `${r.section} – ${r.label}: invoice ${r.invoice ?? 'not read'}, ERP ${r.erp ?? 'none'}`;
  return {
    source: 'erp_receipt',
    verdict,
    headline:
      verdict === 'cleared'
        ? `Cleared: every value matches ERP receipt GRN ${erp.grnNo}`
        : verdict === 'mismatch'
          ? `${mismatches.length} value${mismatches.length === 1 ? ' does' : 's do'} not match ERP receipt GRN ${erp.grnNo}`
          : `Not cleared yet: ${blocking.length} value${blocking.length === 1 ? '' : 's'} could not be compared`,
    summary:
      verdict === 'mismatch'
        ? `Does not match ERP receipt GRN ${erp.grnNo}. ${listed(mismatches.map(describe))}.`
        : verdict === 'cleared'
          ? `Every value read on the invoice matches ERP receipt GRN ${erp.grnNo}; total ${money(inv.totalPaise)}.`
          : `To compare: ${blocking.map((r) => `${r.section} – ${r.label}`).join('; ')}.`,
    matched: rows.filter((r) => r.result === 'match').length,
    mismatched: mismatches.length,
    notChecked: rows.filter((r) => r.result === 'not_checked').length,
    rows: rows.map((r) => ({
      section: r.section,
      label: r.label,
      invoice: r.invoice,
      erp: r.erp,
      result: r.result,
      note: r.note,
    })),
  };
}

/** The first three differences, then how many more (the table shows every one). */
function listed(items: readonly string[]): string {
  const shown = items.slice(0, 3).join('; ');
  return items.length > 3 ? `${shown}; and ${items.length - 3} more` : shown;
}
