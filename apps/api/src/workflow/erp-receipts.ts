import { z } from 'zod';
import {
  formatInr,
  formatQty,
  milliQty,
  normalizeInvoiceNumber,
  paise,
  type ApiComparison,
} from '@veyra/shared';
import { computeTax, lineTaxableAmount, validateGstin } from '@veyra/india-tax';
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
  /** The goods value printed on the invoice ("Taxable Value", "Basic Value", "Sub Total"). */
  taxablePaise?: number | null;
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
    /** GST rate in basis points, as read (for the invoice's own tax arithmetic). */
    gstRateBp?: number | null;
  }[];
}

/** What else Veyrafy knows that the receipt record cannot tell it. */
export interface ReceiptContext {
  /** Other invoices already in Veyrafy with this supplier's invoice number (not rejected). */
  duplicates?: readonly string[];
}

type Row = ApiComparison['rows'][number] & {
  blocking: boolean;
  /** The invoice field the row compares (a blocking row waits for it as a question). */
  path?: string;
};
const money = (p: number | null) => (p === null ? null : formatInr(paise(p)));
const qty = (m: number | null, uom: string | null) =>
  m === null ? null : `${formatQty(milliQty(m))}${uom ? ` ${uom.toUpperCase()}` : ''}`;

export function compareWithReceipt(
  inv: InvoiceSide,
  erp: ReceiptRecord,
  context: ReceiptContext = {},
): ApiComparison {
  return receiptComparison(inv, erp, context).comparison;
}

/**
 * The comparison, and the invoice fields that could not be compared because they were not read
 * with certainty (each is asked as a question, like any other value not read).
 */
export function receiptComparison(
  inv: InvoiceSide,
  erp: ReceiptRecord,
  context: ReceiptContext = {},
): {
  comparison: ApiComparison;
  unread: string[];
  /** The mismatched values with the invoice field each was read from. */
  differences: {
    section: string;
    label: string;
    invoice: string | null;
    erp: string | null;
    path: string | null;
  }[];
  /** Invoice total (before its round-off) less the receipt's total; null when not read. */
  totalDeltaPaise: number | null;
} {
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
    path?: string,
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
        ...(path ? { path } : {}),
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
      ...(path ? { path } : {}),
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

  // Paying the same invoice twice: another copy (a second scan, or the ERP's attachment) of this
  // supplier's invoice number already in Veyrafy is never cleared again.
  const dups = context.duplicates ?? [];
  push({
    section: 'ERP receipt',
    label: 'Not already in Veyrafy',
    invoice: inv.invoiceNumber,
    erp: dups.length ? `Also in Veyrafy: ${dups.join(', ')}` : 'No other copy',
    result: dups.length ? 'mismatch' : 'match',
    blocking: false,
    note: dups.length
      ? 'The same supplier invoice number is already in Veyrafy. Check it is not a duplicate before paying.'
      : null,
  });

  // Supplier.
  cmp(
    'Supplier',
    'Name',
    inv.vendorName,
    erp.vendorName,
    sameName(inv.vendorName, erp.vendorName),
    undefined,
    'header.vendorName',
  );
  cmp(
    'Supplier',
    'GSTIN',
    inv.vendorGstin,
    null,
    null,
    'The ERP record carries no GSTIN.',
    'header.vendorGstin',
  );
  // The GSTIN itself (format, checksum, state code), whether or not the ERP holds one.
  if (inv.vendorGstin !== null) {
    const valid = validateGstin(inv.vendorGstin).ok;
    push({
      section: 'Supplier',
      label: 'GSTIN valid',
      invoice: inv.vendorGstin,
      erp: valid ? 'Valid format, state and checksum' : 'Not a valid GSTIN',
      result: valid ? 'match' : 'mismatch',
      blocking: false,
      note: valid
        ? null
        : 'The GSTIN fails the format or checksum test: input tax credit is at risk.',
      path: 'header.vendorGstin',
    });
  }

  // Invoice.
  cmp(
    'Invoice',
    'Invoice number',
    inv.invoiceNumber,
    erp.invoiceNo,
    inv.invoiceNumber !== null && invoiceNoKey(inv.invoiceNumber) === invoiceNoKey(erp.invoiceNo),
    undefined,
    'header.invoiceNumber',
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
    'header.invoiceDate',
  );
  // Never compared: the ERP record holds its internal order id, and nothing links it to the
  // order number printed on the invoice. So it is shown, never matched, and an order number not
  // read does not hold the invoice up (it would not be compared if it were read).
  push({
    section: 'Purchase order',
    label: 'Order',
    invoice: inv.poNumber,
    erp: erp.poRef ? `ERP reference ${erp.poRef}` : null,
    result: 'not_checked',
    blocking: false,
    note: 'The ERP record holds its internal order id, not the order number printed on the invoice, so the two are not compared.',
  });

  // Lines: paired by item name, then quantity and rate (the ERP may list them in another order).
  // Two lines whose names share no word are never paired by quantity or rate alone: equal
  // quantities are common, and a wrong pairing reports a matching item as different.
  const pairs: { inv: InvoiceSide['lines'][number] | null; erp: ReceiptLine | null }[] = [];
  const freeInv = new Set(inv.lines.map((_, i) => i));
  const freeErp = new Set(erp.lines.map((_, i) => i));
  const scored: { i: number; e: number; s: number }[] = [];
  inv.lines.forEach((l, i) =>
    erp.lines.forEach((el, e) => {
      const name = similarity(l.description, el.name);
      // An item name not read with certainty: quantity and rate together may still pair it.
      const nameUnread = l.description === null;
      if (name === 0 && !nameUnread) return;
      const sameQty = l.qtyMilli !== null && l.qtyMilli === el.qtyMilli;
      const sameRate = l.unitPricePaise !== null && l.unitPricePaise === el.ratePaise;
      if (nameUnread && !(sameQty && sameRate)) return;
      const s = name + (sameQty ? 1 : 0) + (sameRate ? 0.5 : 0);
      scored.push({ i, e, s });
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
      `lines[${l.lineNo}].description`,
    );
    cmp(
      section,
      'HSN/SAC',
      l.hsnSac,
      e.hsn,
      e.hsn === null ? null : l.hsnSac === e.hsn,
      undefined,
      `lines[${l.lineNo}].hsnSac`,
    );
    cmp(
      section,
      'Quantity',
      qty(l.qtyMilli, l.uom),
      qty(e.qtyMilli, e.uom),
      e.qtyMilli === null ? null : l.qtyMilli === e.qtyMilli,
      'Quantity received differs from the invoice.',
      `lines[${l.lineNo}].qtyMilli`,
    );
    cmp(
      section,
      'Rate',
      money(l.unitPricePaise),
      money(e.ratePaise),
      e.ratePaise === null ? null : l.unitPricePaise === e.ratePaise,
      'Rate differs.',
      `lines[${l.lineNo}].unitPricePaise`,
    );
    cmp(
      section,
      'Amount',
      money(l.taxablePaise),
      money(e.amountPaise),
      e.amountPaise === null ? null : l.taxablePaise === e.amountPaise,
      'Amount differs.',
      `lines[${l.lineNo}].taxablePaise`,
    );
  });

  // The invoice's own arithmetic, whatever the ERP says: a receipt that agrees with a wrongly
  // calculated invoice must not clear it.
  for (const l of inv.lines) {
    if (l.qtyMilli === null || l.unitPricePaise === null || l.taxablePaise === null) continue;
    const expected = lineTaxableAmount(milliQty(l.qtyMilli), paise(l.unitPricePaise)) as number;
    push({
      section: 'Invoice arithmetic',
      label: `Line ${l.lineNo}: quantity × rate`,
      invoice: money(l.taxablePaise),
      erp: `${money(expected)} calculated`,
      result: expected === l.taxablePaise ? 'match' : 'mismatch',
      blocking: false,
      note: expected === l.taxablePaise ? null : 'The line amount is not quantity × rate.',
      path: `lines[${l.lineNo}].taxablePaise`,
    });
  }
  const lineTaxable = inv.lines.every((l) => l.taxablePaise !== null)
    ? inv.lines.reduce((s, l) => s + (l.taxablePaise ?? 0), 0)
    : null;
  // The goods value as printed; else, when every line amount was read, their sum (labelled so).
  // A taxable value printed with the freight in it is the lines' value plus that freight.
  const printedTaxable = inv.taxablePaise ?? null;
  const invFreight = inv.freightPaise ?? 0;
  const withFreight =
    printedTaxable !== null &&
    invFreight !== 0 &&
    lineTaxable !== null &&
    printedTaxable === lineTaxable + invFreight;
  const printedGoods =
    printedTaxable !== null && withFreight ? printedTaxable - invFreight : printedTaxable;
  const invGoods = printedGoods ?? lineTaxable;
  if (printedTaxable !== null && lineTaxable !== null && inv.lines.length > 0) {
    const ok = printedGoods === lineTaxable;
    push({
      section: 'Invoice arithmetic',
      label: 'Line amounts add up to the goods value',
      invoice: money(printedTaxable),
      erp: `${money(lineTaxable)}${withFreight ? ` + freight ${money(invFreight)}` : ''} calculated`,
      result: ok ? 'match' : 'mismatch',
      blocking: false,
      note: ok ? null : 'The line amounts do not add up to the goods value printed.',
      path: 'header.taxablePaise',
    });
  }
  const printedTax = (inv.cgstPaise ?? 0) + (inv.sgstPaise ?? 0) + (inv.igstPaise ?? 0);
  const unreadRate = inv.lines.find((l) => l.gstRateBp === null || l.gstRateBp === undefined);
  if ((inv.freightPaise ?? 0) !== 0) {
    push({
      section: 'Invoice arithmetic',
      label: 'GST calculated from the rates',
      invoice: money(printedTax),
      erp: null,
      result: 'not_checked',
      blocking: false,
      note: 'Freight is taxed on its own, so the tax is compared with the ERP instead.',
    });
  } else if (unreadRate) {
    push({
      section: 'Invoice arithmetic',
      label: 'GST calculated from the rates',
      invoice: money(printedTax),
      erp: null,
      result: 'not_checked',
      blocking: true,
      note: 'The GST rate was not read with certainty on every line.',
      path: `lines[${unreadRate.lineNo}].gstRateBp`,
    });
  } else if (lineTaxable !== null) {
    // Indian invoices compute GST per line or on each rate's total; either rounding is accepted.
    const supply = (inv.igstPaise ?? 0) > 0 ? 'inter_state' : 'intra_state';
    const perLine = inv.lines.reduce((s, l) => {
      const h = computeTax(paise(l.taxablePaise ?? 0), (l.gstRateBp ?? 0) as never, supply);
      return s + (h.cgstPaise as number) + (h.sgstPaise as number) + (h.igstPaise as number);
    }, 0);
    const groups = new Map<number, number>();
    for (const l of inv.lines)
      groups.set(l.gstRateBp ?? 0, (groups.get(l.gstRateBp ?? 0) ?? 0) + (l.taxablePaise ?? 0));
    const perRate = [...groups].reduce((s, [rate, taxable]) => {
      const h = computeTax(paise(taxable), rate as never, supply);
      return s + (h.cgstPaise as number) + (h.sgstPaise as number) + (h.igstPaise as number);
    }, 0);
    const ok = printedTax === perLine || printedTax === perRate;
    push({
      section: 'Invoice arithmetic',
      label: 'GST calculated from the rates',
      invoice: money(printedTax),
      erp: `${money(perRate)} calculated`,
      result: ok ? 'match' : 'mismatch',
      blocking: false,
      note: ok ? null : 'The tax printed is not the GST rate applied to the line amounts.',
    });
  }
  if (invGoods !== null && inv.totalPaise !== null) {
    const expected = invGoods + printedTax + (inv.freightPaise ?? 0) + (inv.roundOffPaise ?? 0);
    push({
      section: 'Invoice arithmetic',
      label: 'Lines + tax + round-off = total',
      invoice: money(inv.totalPaise),
      erp: `${money(expected)} calculated`,
      result: expected === inv.totalPaise ? 'match' : 'mismatch',
      blocking: false,
      note: expected === inv.totalPaise ? null : 'The invoice total does not add up.',
    });
  }

  // Charges and totals.
  const sum = (k: 'freightPaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'amountPaise') =>
    erp.lines.reduce((s, l) => s + (l[k] ?? 0), 0);
  const goods = sum('amountPaise');
  cmp(
    'Totals',
    printedGoods !== null ? 'Goods value' : 'Goods value (sum of lines)',
    printedGoods !== null
      ? `${money(printedGoods)}${withFreight ? ` (printed ${money(printedTaxable)} with freight)` : ''}`
      : lineTaxable !== null
        ? `${money(lineTaxable)} calculated`
        : null,
    money(goods),
    invGoods === goods,
    undefined,
    printedGoods !== null ? 'header.taxablePaise' : undefined,
  );
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
    cmp(
      'Totals',
      label,
      money(printed),
      money(erpTax),
      printed === erpTax,
      undefined,
      `header.${k}`,
    );
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
    'header.totalPaise',
  );
  cmp(
    'Totals',
    'Invoice amount recorded in the ERP',
    money(inv.totalPaise),
    recorded ? money(erp.erpInvoiceAmountPaise) : null,
    recorded ? inv.totalPaise === erp.erpInvoiceAmountPaise : null,
    recorded ? undefined : 'The ERP has not recorded the invoice amount yet (it is 0).',
    'header.totalPaise',
  );

  const mismatches = rows.filter((r) => r.result === 'mismatch');
  const blocking = rows.filter((r) => r.result === 'not_checked' && r.blocking);
  const verdict: ApiComparison['verdict'] = mismatches.length
    ? 'mismatch'
    : blocking.length
      ? 'incomplete'
      : 'cleared';
  const matchedCount = rows.filter((r) => r.result === 'match').length;
  const notCompared = rows.filter((r) => r.result === 'not_checked').length;
  const describe = (r: Row) =>
    `${r.section} – ${r.label}: invoice ${r.invoice ?? 'not read'}, ERP ${r.erp ?? 'none'}`;
  const comparison: ApiComparison = {
    source: 'erp_receipt',
    verdict,
    headline:
      verdict === 'cleared'
        ? notCompared > 0
          ? `Cleared: ${matchedCount} values match ERP receipt GRN ${erp.grnNo}`
          : `Cleared: every value matches ERP receipt GRN ${erp.grnNo}`
        : verdict === 'mismatch'
          ? `${mismatches.length} value${mismatches.length === 1 ? ' does' : 's do'} not match ERP receipt GRN ${erp.grnNo}`
          : `Not cleared yet: ${blocking.length} value${blocking.length === 1 ? '' : 's'} could not be compared`,
    summary:
      verdict === 'mismatch'
        ? `Does not match ERP receipt GRN ${erp.grnNo}. ${listed(mismatches.map(describe))}.`
        : verdict === 'cleared'
          ? `${notCompared > 0 ? `${matchedCount} values match ERP receipt GRN ${erp.grnNo} and the invoice's own checks; ${notCompared} not held by the ERP were not compared (${listed(rows.filter((r) => r.result === 'not_checked').map((r) => r.label))})` : `Every value read on the invoice matches ERP receipt GRN ${erp.grnNo}`}; total ${money(inv.totalPaise)}.`
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
  const unread = [...new Set(blocking.flatMap((r) => (r.path ? [r.path] : [])))];
  const differences = mismatches.map((r) => ({
    section: r.section,
    label: r.label,
    invoice: r.invoice,
    erp: r.erp,
    path: r.path ?? null,
  }));
  const totalDeltaPaise = beforeRounding === null ? null : beforeRounding - erpTotal;
  return { comparison, unread, differences, totalDeltaPaise };
}

/** The first three differences, then how many more (the table shows every one). */
function listed(items: readonly string[]): string {
  const shown = items.slice(0, 3).join('; ');
  return items.length > 3 ? `${shown}; and ${items.length - 3} more` : shown;
}
