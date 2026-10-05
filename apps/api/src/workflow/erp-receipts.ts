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
/**
 * Cyrillic and Greek letters that print exactly like a Latin capital (an OCR or a font can give
 * "МIRROR" with a Cyrillic М). Mapped to the Latin letter they look like in capitals, the way
 * item names are printed; nothing else is changed.
 */
const LOOKALIKE: Readonly<Record<string, string>> = Object.fromEntries(
  (
    [
      ['АаΑα', 'a'],
      ['ВвΒβ', 'b'],
      ['СсϹϲ', 'c'],
      ['ЕеΕε', 'e'],
      ['НнΗη', 'h'],
      ['ІіΙι', 'i'],
      ['Јј', 'j'],
      ['КкΚκ', 'k'],
      ['МмΜμ', 'm'],
      ['Νν', 'n'],
      ['ОоΟο', 'o'],
      ['РрΡρ', 'p'],
      ['Ѕѕ', 's'],
      ['ТтΤτ', 't'],
      ['УуΥυ', 'y'],
      ['ХхΧχ', 'x'],
      ['Ζζ', 'z'],
    ] as const
  ).flatMap(([from, to]) => [...from].map((c) => [c, to])),
);
/** "mirrors" → "mirror", "boxes" → "box", "batteries" → "battery"; "glass" and short words stay. */
function singular(t: string): string {
  if (t.length <= 3 || !t.endsWith('s') || t.endsWith('ss') || /\d/.test(t)) return t;
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (/(?:x|ch|sh|ss)es$/.test(t)) return t.slice(0, -2);
  return t.slice(0, -1);
}
const tokens = (s: string): Set<string> =>
  new Set(
    [...s.normalize('NFKC')]
      .map((c) => LOOKALIKE[c] ?? c)
      .join('')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t && !STOP.has(t) && !/^\d{2,4}$/.test(t))
      .map(singular),
  );
const subset = (a: Set<string>, b: Set<string>) => a.size > 0 && [...a].every((t) => b.has(t));
/** Two names are the same when every word of one appears in the other (case, punctuation,
 *  plurals, look-alike letters and "Pvt Ltd"-style words ignored). "176x89mm" and "175x89mm" are
 *  different words. */
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

/** How many of the invoice's lines a receipt's lines account for (by name, then quantity). */
function lineFit(lines: InvoiceSide['lines'], erp: ReceiptRecord): number {
  return lines.reduce((s, l) => {
    const named = erp.lines.filter((e) => sameName(l.description, e.name));
    if (named.length === 0) return s;
    return s + 1 + (named.some((e) => l.qtyMilli !== null && e.qtyMilli === l.qtyMilli) ? 1 : 0);
  }, 0);
}

/**
 * The ERP record an invoice belongs to: same invoice number, and the same supplier if read. A
 * receipt exported again (same GRN number) replaces the earlier export. When the ERP holds more
 * than one receipt for the invoice, the one whose lines fit the invoice best is compared and the
 * others are returned, so the comparison asks which receipt is right instead of assuming it.
 */
export function pickRecord<T extends { record: ReceiptRecord }>(
  candidates: readonly T[],
  vendorName: string | null,
  lines: InvoiceSide['lines'] = [],
): { picked: T; alternatives: T[] } | null {
  const fits = vendorName
    ? candidates.filter((c) => sameName(c.record.vendorName, vendorName))
    : [...candidates];
  const latest = new Map<string, T>();
  for (const c of fits) {
    latest.delete(c.record.grnNo);
    latest.set(c.record.grnNo, c);
  }
  const all = [...latest.values()];
  if (all.length === 0) return null;
  // Best fit; on a tie the most recently exported.
  let picked = all[all.length - 1] as T;
  let best = lineFit(lines, picked.record);
  for (const c of all) {
    const f = lineFit(lines, c.record);
    if (f > best) {
      best = f;
      picked = c;
    }
  }
  return { picked, alternatives: all.filter((c) => c !== picked) };
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
  /**
   * Header values printed but not read with certainty (paths). Null above means "not printed"
   * only when the path is not listed here: an unread round-off or tax is never taken as zero.
   */
  unclear?: readonly string[];
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
  /** Other ERP receipts (GRN numbers) for the same supplier invoice, not compared. */
  otherReceipts?: readonly string[];
}

type Result = ApiComparison['rows'][number]['result'];
type Row = ApiComparison['rows'][number] & {
  /** The invoice field the row compares (a value to confirm is asked as a question). */
  path?: string;
};
const money = (p: number | null) => (p === null ? null : formatInr(paise(p)));
const qty = (m: number | null, uom: string | null) =>
  m === null ? null : `${formatQty(milliQty(m))}${uom ? ` ${uom.toUpperCase()}` : ''}`;

/** A row that is a difference or something to confirm, as the finding and the summary use it. */
export interface ReceiptDifference {
  section: string;
  label: string;
  invoice: string | null;
  erp: string | null;
  path: string | null;
  /** Not a proven difference: a person must confirm it (shown as "confirm", never "differ"). */
  confirm: boolean;
}

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
 *
 * Every row has exactly one result:
 * - `match` / `mismatch`: both sides hold the value and it was compared;
 * - `unmatched`: an item on one side with no counterpart on the other;
 * - `needs_confirmation`: there is not enough evidence either way (a required value not read with
 *   certainty, or two items that may be the same); the invoice waits for a person;
 * - `not_compared`: there is nothing to compare it with (the ERP does not hold the value, or the
 *   two are different kinds of value); it never holds the invoice up and is never a difference.
 * The counts are taken from these final rows only.
 */
export function receiptComparison(
  inv: InvoiceSide,
  erp: ReceiptRecord,
  context: ReceiptContext = {},
): {
  comparison: ApiComparison;
  unread: string[];
  /** Differences (mismatched and unmatched) and the items to confirm, with their invoice field. */
  differences: ReceiptDifference[];
  /** Invoice total (before its round-off) less the receipt's total; null when not read. */
  totalDeltaPaise: number | null;
} {
  const rows: Row[] = [];
  const push = (r: Omit<Row, 'note'> & { note?: string | null }) => rows.push({ note: null, ...r });
  /**
   * Compare two values. A required value not read on the invoice must be confirmed; an optional
   * one not read, a value the ERP does not hold, or one that cannot be compared, is not compared.
   */
  const cmp = (
    section: string,
    label: string,
    invoice: string | null,
    erpText: string | null,
    equal: boolean | null,
    o: { note?: string; path?: string; required?: boolean } = {},
  ) => {
    const path = o.path ? { path: o.path } : {};
    if (invoice === null)
      return o.required === false
        ? push({
            section,
            label,
            invoice,
            erp: erpText,
            result: 'not_compared',
            note: 'Not read on the invoice; not needed to clear it.',
          })
        : push({
            section,
            label,
            invoice,
            erp: erpText,
            result: 'needs_confirmation',
            note: 'Not read on the invoice with certainty. Confirm it to compare.',
            ...path,
          });
    if (erpText === null || equal === null)
      return push({
        section,
        label,
        invoice,
        erp: erpText,
        result: 'not_compared',
        note: o.note ?? 'The ERP record does not hold this value.',
      });
    return push({
      section,
      label,
      invoice,
      erp: erpText,
      result: equal ? 'match' : 'mismatch',
      note: equal ? null : (o.note ?? 'The invoice and the ERP differ.'),
      ...path,
    });
  };

  // The record itself.
  const others = context.otherReceipts ?? [];
  push({
    section: 'ERP receipt',
    label: 'Matched ERP record',
    invoice: inv.invoiceNumber,
    erp: `GRN ${erp.grnNo}${erp.grnDate ? ` of ${dateText(erp.grnDate)}` : ''}`,
    result: others.length ? 'needs_confirmation' : 'match',
    note: others.length
      ? `Your ERP holds more than one receipt for this invoice (also GRN ${others.join(', GRN ')}). GRN ${erp.grnNo} fits the invoice best; confirm it is the right one.`
      : 'Found by the supplier’s invoice number and name.',
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
    {
      path: 'header.vendorName',
    },
  );
  cmp('Supplier', 'GSTIN', inv.vendorGstin, null, null, {
    note: 'The ERP record carries no GSTIN.',
    path: 'header.vendorGstin',
  });
  // The GSTIN itself (format, checksum, state code), whether or not the ERP holds one.
  if (inv.vendorGstin !== null) {
    const valid = validateGstin(inv.vendorGstin).ok;
    push({
      section: 'Supplier',
      label: 'GSTIN valid',
      invoice: inv.vendorGstin,
      erp: valid ? 'Valid format, state and checksum' : 'Not a valid GSTIN',
      result: valid ? 'match' : 'mismatch',
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
    { path: 'header.invoiceNumber' },
  );
  const recorded = erp.erpInvoiceAmountPaise !== null && erp.erpInvoiceAmountPaise > 0;
  cmp(
    'Invoice',
    'Invoice date',
    inv.invoiceDate ? dateText(inv.invoiceDate) : null,
    recorded && erp.erpInvoiceDate ? dateText(erp.erpInvoiceDate) : null,
    recorded ? inv.invoiceDate === erp.erpInvoiceDate : null,
    {
      ...(recorded
        ? {}
        : {
            note: `The ERP has not recorded this invoice yet (its invoice amount is 0)${erp.erpInvoiceDate ? `, so its date ${dateText(erp.erpInvoiceDate)} is not compared` : ''}.`,
          }),
      path: 'header.invoiceDate',
    },
  );
  // Never compared: the ERP record holds its internal order id, and nothing links it to the
  // order number printed on the invoice. Both are shown as they are, never matched, and an order
  // number not read does not hold the invoice up (it would not be compared if it were read).
  push({
    section: 'Purchase order',
    label: 'Order',
    invoice: inv.poNumber,
    erp: erp.poRef ? `ERP internal reference ${erp.poRef}` : null,
    result: 'not_compared',
    note: 'The ERP record holds its internal order id, not the order number printed on the invoice, so the two are not compared.',
  });

  // Lines, one to one. First by item name (the ERP may list them in another order); then two
  // items whose names share no word are never paired: when exactly one invoice item and one ERP
  // item are left that agree on quantity, rate and amount, they are shown once as "possibly the
  // same item" for a person to confirm, never as a match and never as two differences.
  type InvLine = InvoiceSide['lines'][number];
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
      const s =
        (sameName(l.description, el.name) ? 2 : name) + (sameQty ? 1 : 0) + (sameRate ? 0.5 : 0);
      scored.push({ i, e, s });
    }),
  );
  // Highest score first; equal scores in document order (repeated names pair in order).
  scored.sort((a, b) => b.s - a.s || a.i - b.i || a.e - b.e);
  for (const { i, e } of scored)
    if (freeInv.has(i) && freeErp.has(e)) {
      freeInv.delete(i);
      freeErp.delete(e);
      pairs.push({ inv: inv.lines[i] ?? null, erp: erp.lines[e] ?? null });
    }
  /** Agree on quantity, and on rate and amount wherever both sides hold them (one at least). */
  const sameValues = (l: InvLine, e: ReceiptLine) =>
    l.qtyMilli !== null &&
    l.qtyMilli === e.qtyMilli &&
    (l.unitPricePaise === null || e.ratePaise === null || l.unitPricePaise === e.ratePaise) &&
    (l.taxablePaise === null || e.amountPaise === null || l.taxablePaise === e.amountPaise) &&
    ((l.unitPricePaise !== null && l.unitPricePaise === e.ratePaise) ||
      (l.taxablePaise !== null && l.taxablePaise === e.amountPaise));
  const possible: { inv: InvLine; erp: ReceiptLine }[] = [];
  for (const i of [...freeInv]) {
    const l = inv.lines[i] as InvLine;
    const fit = [...freeErp].filter((e) => sameValues(l, erp.lines[e] as ReceiptLine));
    if (fit.length !== 1) continue;
    const e = fit[0] as number;
    const back = [...freeInv].filter((j) =>
      sameValues(inv.lines[j] as InvLine, erp.lines[e] as ReceiptLine),
    );
    if (back.length !== 1) continue;
    freeInv.delete(i);
    freeErp.delete(e);
    possible.push({ inv: l, erp: erp.lines[e] as ReceiptLine });
  }
  // An invoice item whose name was not read could be any ERP item left over.
  const unreadLeft = [...freeInv].some((i) => inv.lines[i]?.description === null);
  type Entry =
    | { kind: 'pair'; inv: InvLine; erp: ReceiptLine }
    | { kind: 'possible'; inv: InvLine; erp: ReceiptLine }
    | { kind: 'invoice'; inv: InvLine }
    | { kind: 'erp'; erp: ReceiptLine };
  const entries: Entry[] = [
    ...pairs.map((p) => ({
      kind: 'pair' as const,
      inv: p.inv as InvLine,
      erp: p.erp as ReceiptLine,
    })),
    ...possible.map((p) => ({ kind: 'possible' as const, ...p })),
    ...[...freeInv].map((i) => ({ kind: 'invoice' as const, inv: inv.lines[i] as InvLine })),
    ...[...freeErp].map((e) => ({ kind: 'erp' as const, erp: erp.lines[e] as ReceiptLine })),
  ];
  const lineOf = (x: Entry) => ('inv' in x ? x.inv.lineNo : 999);
  entries.sort((a, b) => lineOf(a) - lineOf(b));

  entries.forEach((p, n) => {
    const section = `Line ${'inv' in p ? p.inv.lineNo : n + 1} · ${'erp' in p ? p.erp.name : (p.inv.description ?? '')}`;
    if (p.kind === 'possible') {
      push({
        section,
        label: 'Item',
        invoice: p.inv.description,
        erp: p.erp.name,
        result: 'needs_confirmation',
        // An item name not read is asked as a question (the rest of the line agrees).
        ...(p.inv.description === null ? { path: `lines[${p.inv.lineNo}].description` } : {}),
        note: `The names differ, but quantity${p.inv.unitPricePaise !== null && p.inv.unitPricePaise === p.erp.ratePaise ? ', rate' : ''}${p.inv.taxablePaise !== null && p.inv.taxablePaise === p.erp.amountPaise ? ' and amount' : ''} agree. Confirm whether this is the same item: it is not counted as a match or a difference.`,
      });
      return;
    }
    if (p.kind === 'invoice') {
      if (p.inv.description === null) {
        push({
          section,
          label: 'Item',
          invoice: null,
          erp: null,
          result: 'needs_confirmation',
          note: 'The item name was not read with certainty, so it could not be found in the ERP receipt. Confirm it to compare.',
          path: `lines[${p.inv.lineNo}].description`,
        });
        return;
      }
      push({
        section,
        label: 'Item',
        invoice: p.inv.description,
        erp: null,
        result: 'unmatched',
        note: 'On the invoice, but not in the ERP receipt.',
      });
      return;
    }
    if (p.kind === 'erp') {
      push({
        section,
        label: 'Item',
        invoice: null,
        erp: p.erp.name,
        result: unreadLeft ? 'needs_confirmation' : 'unmatched',
        note: unreadLeft
          ? 'Received in the ERP; it may be the invoice item whose name was not read.'
          : 'Received in the ERP, but not on the invoice.',
      });
      return;
    }
    const l = p.inv;
    const e = p.erp;
    cmp(section, 'Item', l.description, e.name, sameName(l.description, e.name), {
      note: 'The item names differ.',
      path: `lines[${l.lineNo}].description`,
    });
    cmp(section, 'HSN/SAC', l.hsnSac, e.hsn, e.hsn === null ? null : l.hsnSac === e.hsn, {
      path: `lines[${l.lineNo}].hsnSac`,
      // Only needed when the ERP holds one to compare.
      required: e.hsn !== null,
    });
    cmp(
      section,
      'Quantity',
      qty(l.qtyMilli, l.uom),
      qty(e.qtyMilli, e.uom),
      e.qtyMilli === null ? null : l.qtyMilli === e.qtyMilli,
      { note: 'Quantity received differs from the invoice.', path: `lines[${l.lineNo}].qtyMilli` },
    );
    cmp(
      section,
      'Rate',
      money(l.unitPricePaise),
      money(e.ratePaise),
      e.ratePaise === null ? null : l.unitPricePaise === e.ratePaise,
      {
        note: 'Rate differs.',
        path: `lines[${l.lineNo}].unitPricePaise`,
        required: e.ratePaise !== null,
      },
    );
    cmp(
      section,
      'Amount',
      money(l.taxablePaise),
      money(e.amountPaise),
      e.amountPaise === null ? null : l.taxablePaise === e.amountPaise,
      { note: 'Amount differs.', path: `lines[${l.lineNo}].taxablePaise` },
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
      note: ok ? null : 'The line amounts do not add up to the goods value printed.',
      path: 'header.taxablePaise',
    });
  }
  const printedTax = (inv.cgstPaise ?? 0) + (inv.sgstPaise ?? 0) + (inv.igstPaise ?? 0);
  const unreadRate = inv.lines.find((l) => l.gstRateBp === null || l.gstRateBp === undefined);
  const unclear = (...paths: string[]) => paths.find((x) => inv.unclear?.includes(x));
  const taxUnclear = unclear('header.cgstPaise', 'header.sgstPaise', 'header.igstPaise');
  const sumUnclear = unclear('header.roundOffPaise') ?? taxUnclear;
  const notRead =
    'A value it depends on was not read with certainty; it is asked, never taken as zero.';
  if ((inv.freightPaise ?? 0) !== 0) {
    push({
      section: 'Invoice arithmetic',
      label: 'GST calculated from the rates',
      invoice: money(printedTax),
      erp: null,
      result: 'not_compared',
      note: 'Freight is taxed on its own, so the tax is compared with the ERP instead.',
    });
  } else if (taxUnclear) {
    push({
      section: 'Invoice arithmetic',
      label: 'GST calculated from the rates',
      invoice: null,
      erp: null,
      result: 'needs_confirmation',
      note: notRead,
      path: taxUnclear,
    });
  } else if (unreadRate) {
    push({
      section: 'Invoice arithmetic',
      label: 'GST calculated from the rates',
      invoice: money(printedTax),
      erp: null,
      result: 'needs_confirmation',
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
      note: ok ? null : 'The tax printed is not the GST rate applied to the line amounts.',
    });
  }
  if (invGoods !== null && inv.totalPaise !== null && sumUnclear) {
    push({
      section: 'Invoice arithmetic',
      label: 'Lines + tax + round-off = total',
      invoice: money(inv.totalPaise),
      erp: null,
      result: 'needs_confirmation',
      note: notRead,
      path: sumUnclear,
    });
  } else if (invGoods !== null && inv.totalPaise !== null) {
    const expected = invGoods + printedTax + (inv.freightPaise ?? 0) + (inv.roundOffPaise ?? 0);
    push({
      section: 'Invoice arithmetic',
      label: 'Lines + tax + round-off = total',
      invoice: money(inv.totalPaise),
      erp: `${money(expected)} calculated`,
      result: expected === inv.totalPaise ? 'match' : 'mismatch',
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
    printedGoods !== null ? { path: 'header.taxablePaise' } : {},
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
    cmp('Totals', label, money(printed), money(erpTax), printed === erpTax, {
      path: `header.${k}`,
    });
  }
  const charges = erp.lines.flatMap((l) => l.other);
  for (const code of [...new Set(charges.map((o) => o.code))])
    push({
      section: 'Totals',
      label: `Other charge (your ERP's code ${code})`,
      invoice: null,
      erp: money(charges.filter((o) => o.code === code).reduce((s, o) => s + o.paise, 0)),
      result: 'needs_confirmation',
      note: "A charge in your ERP that Veyrafy doesn't recognise yet; it is included in the ERP total.",
    });
  const erpTotal =
    goods +
    freight +
    sum('cgstPaise') +
    sum('sgstPaise') +
    sum('igstPaise') +
    charges.reduce((s, o) => s + o.paise, 0);
  const roundOffUnclear = unclear('header.roundOffPaise');
  const beforeRounding =
    inv.totalPaise === null || roundOffUnclear ? null : inv.totalPaise - (inv.roundOffPaise ?? 0);
  if (inv.totalPaise !== null && roundOffUnclear)
    push({
      section: 'Totals',
      label: 'Invoice total',
      invoice: money(inv.totalPaise),
      erp: money(erpTotal),
      result: 'needs_confirmation',
      note: 'The round-off was not read with certainty, so the total is not compared yet.',
      path: roundOffUnclear,
    });
  else
    cmp(
      'Totals',
      'Invoice total',
      money(inv.totalPaise),
      `${money(erpTotal)}${inv.roundOffPaise ? ` (invoice rounds by ${money(inv.roundOffPaise)})` : ''}`,
      beforeRounding === erpTotal,
      {
        note: 'The invoice total differs from the ERP receipt’s total.',
        path: 'header.totalPaise',
      },
    );
  // The ERP's own record of the invoice amount: compared only when the ERP holds it. A total not
  // read is already asked once, above.
  cmp(
    'Totals',
    'Invoice amount recorded in the ERP',
    money(inv.totalPaise),
    recorded ? money(erp.erpInvoiceAmountPaise) : null,
    recorded ? inv.totalPaise === erp.erpInvoiceAmountPaise : null,
    {
      ...(recorded ? {} : { note: 'The ERP has not recorded the invoice amount yet (it is 0).' }),
      path: 'header.totalPaise',
      required: false,
    },
  );

  const of = (result: Result) => rows.filter((r) => r.result === result);
  const mismatched = of('mismatch');
  const unmatched = of('unmatched');
  const toConfirm = of('needs_confirmation');
  const notCompared = of('not_compared');
  const matchedCount = of('match').length;
  const differing = rows.filter((r) => r.result === 'mismatch' || r.result === 'unmatched');
  const verdict: ApiComparison['verdict'] = differing.length
    ? 'mismatch'
    : toConfirm.length
      ? 'incomplete'
      : 'cleared';
  const describe = (r: Row) =>
    r.result === 'unmatched'
      ? `${r.section}: ${r.invoice !== null ? 'on the invoice, not in the ERP receipt' : 'in the ERP receipt, not on the invoice'}`
      : `${r.section} – ${r.label}: invoice ${r.invoice ?? 'not read'}, ERP ${r.erp ?? 'none'}`;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const confirmText = toConfirm.length
    ? ` To confirm: ${toConfirm.map((r) => `${r.section} – ${r.label}`).join('; ')}.`
    : '';
  const comparison: ApiComparison = {
    source: 'erp_receipt',
    verdict,
    headline:
      verdict === 'cleared'
        ? notCompared.length > 0
          ? `Cleared: ${matchedCount} values match ERP receipt GRN ${erp.grnNo}`
          : `Cleared: every value matches ERP receipt GRN ${erp.grnNo}`
        : verdict === 'mismatch'
          ? `${plural(differing.length, 'difference', 'differences')} from ERP receipt GRN ${erp.grnNo}${toConfirm.length ? `; ${toConfirm.length} to confirm` : ''}`
          : `Not cleared yet: ${plural(toConfirm.length, 'value', 'values')} to confirm`,
    summary:
      verdict === 'mismatch'
        ? `Does not match ERP receipt GRN ${erp.grnNo}. ${listed(differing.map(describe))}.${confirmText}`
        : verdict === 'cleared'
          ? `${notCompared.length > 0 ? `${matchedCount} values match ERP receipt GRN ${erp.grnNo} and the invoice's own checks; ${notCompared.length} not held by the ERP were not compared (${listed(notCompared.map((r) => r.label))})` : `Every value read on the invoice matches ERP receipt GRN ${erp.grnNo}`}; total ${money(inv.totalPaise)}.`
          : `To confirm: ${toConfirm.map((r) => `${r.section} – ${r.label}`).join('; ')}.`,
    matched: matchedCount,
    mismatched: mismatched.length,
    unmatched: unmatched.length,
    needsConfirmation: toConfirm.length,
    notCompared: notCompared.length,
    rows: rows.map((r) => ({
      section: r.section,
      label: r.label,
      invoice: r.invoice,
      erp: r.erp,
      result: r.result,
      note: r.note,
    })),
  };
  const unread = [...new Set(toConfirm.flatMap((r) => (r.path ? [r.path] : [])))];
  const differences: ReceiptDifference[] = [
    ...differing.map((r) => ({ r, confirm: false })),
    // Values to confirm that are not a question about a value read (the same item? which GRN?).
    ...toConfirm.filter((r) => !r.path).map((r) => ({ r, confirm: true })),
  ].map(({ r, confirm }) => ({
    section: r.section,
    label: r.label,
    invoice: r.invoice,
    erp: r.erp,
    path: r.path ?? null,
    confirm,
  }));
  const totalDeltaPaise = beforeRounding === null ? null : beforeRounding - erpTotal;
  return { comparison, unread, differences, totalDeltaPaise };
}

/** The first three differences, then how many more (the table shows every one). */
function listed(items: readonly string[]): string {
  const shown = items.slice(0, 3).join('; ');
  return items.length > 3 ? `${shown}; and ${items.length - 3} more` : shown;
}
