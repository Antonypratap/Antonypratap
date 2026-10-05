import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  confidenceBp,
  normalizeUom,
  parseQuantity,
  parseRatePercent,
  type ExtractedField,
  type ExtractedHeader,
  type ExtractedLine,
  type ExtractionResult,
  type OtherPrintedField,
} from '@veyra/shared';
import { ExtractorError, type Extractor, type ExtractorInput } from '../extractor';
import { imageSize } from '../local/image';
import { footerRateProven, parseAmount, parseDate } from '../local/parse';
import { rotationNote, uprightImage, type Rotation } from '../local/orientation';

/**
 * The AI vision reader (Gemini). It reads the original document (PDF pages or a photo) the way a
 * person would and returns, for every field, the text exactly as it is PRINTED. It never decides:
 *
 * - Every value is re-parsed from that printed text by Veyrafy's own deterministic parsers (money
 *   to the paisa, RULES §1.4 dates, GSTIN checksum, quantities, rates). The model's own
 *   normalisation is never used, so it cannot invent a value that is not printed.
 * - A value that parses gets AI_CONFIDENCE_BP; one that does not (a two-digit year, an invalid
 *   GSTIN, an unreadable amount) is kept as evidence below the threshold, so a person is asked.
 * - The deterministic core then checks everything as for any reading (line arithmetic, totals,
 *   tax rates, supplier, order, goods receipt). Disagreement is a question, never a guess.
 *
 * If the AI is unreachable or answers badly, the local reader reads the document instead, and the
 * invoice says so. Document contents and the API key are never logged.
 */

/** Confidence of an AI-read value that Veyrafy's parsers accept: at the default 0.90 threshold. */
export const AI_CONFIDENCE_BP = 9200;
/** Confidence of an AI-read value Veyrafy cannot accept as printed: always asked. */
const DOUBTFUL_BP = 4000;
/** Inline documents above this go to the local reader (the API's request limit, base64-encoded). */
const MAX_INLINE_BYTES = 14 * 1024 * 1024;

/** Where on its page a value is printed: [ymin, xmin, ymax, xmax], each 0–1000 of the page. */
// A box that is not four numbers is dropped (the value keeps its page and text).
const Box = z.array(z.number()).length(4).nullable().optional().catch(null);
const Printed = z
  .object({
    printed: z.string().nullable(),
    page: z.number().int().positive().nullable().catch(null),
    unreadable: z.boolean().nullable().optional().catch(null),
    box: Box,
  })
  .nullable()
  // A value the model returned in a shape Veyrafy cannot use is treated as printed but unreadable
  // (so it is asked), never as "not printed", and never loses the rest of the reading.
  .catch({ printed: null, page: null, unreadable: true, box: null });
type Printed = z.infer<typeof Printed>;

const HEADER_KEYS = [
  'vendorName',
  'vendorGstin',
  'vendorAddress',
  'vendorPan',
  'buyerGstin',
  'billingAddress',
  'placeOfSupply',
  'shipToState',
  'shipToGstin',
  'shipToAddress',
  'invoiceNumber',
  'invoiceDate',
  'poNumber',
  'taxable',
  'cgst',
  'sgst',
  'igst',
  'cess',
  'roundOff',
  'total',
] as const;
const LINE_KEYS = [
  'description',
  'itemCode',
  'hsn',
  'quantity',
  'uom',
  'rate',
  'discount',
  'taxable',
  'gstRate',
  'cgst',
  'sgst',
  'igst',
  'lineTotal',
] as const;

/** What the model must return (validated; anything else is an unusable answer). */
export const AiReadingSchema = z.object({
  invoiceCount: z.number().int().nonnegative(),
  invoiceNumbers: z.array(z.string()).nullable().optional(),
  pageCount: z.number().int().positive().nullable().optional(),
  header: z.object(Object.fromEntries(HEADER_KEYS.map((k) => [k, Printed.optional()]))),
  lines: z.array(z.object(Object.fromEntries(LINE_KEYS.map((k) => [k, Printed.optional()])))),
  otherCharges: z
    .array(z.object({ label: z.string(), amount: z.string().nullable() }))
    .nullable()
    .optional()
    .catch(null),
  otherPrinted: z
    .array(
      z.object({
        label: z.string(),
        printed: z.string().nullable(),
        page: z.number().int().positive().nullable().optional(),
        box: Box,
      }),
    )
    .nullable()
    .optional()
    .catch(null),
});
export type AiReading = z.infer<typeof AiReadingSchema>;

const printedSchema = {
  type: 'OBJECT',
  nullable: true,
  properties: {
    printed: { type: 'STRING', nullable: true },
    page: { type: 'INTEGER', nullable: true },
    unreadable: { type: 'BOOLEAN', nullable: true },
    box: { type: 'ARRAY', items: { type: 'INTEGER' }, nullable: true },
  },
};
/** The structured-output schema sent to Gemini (OpenAPI subset). */
export const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    invoiceCount: { type: 'INTEGER' },
    invoiceNumbers: { type: 'ARRAY', items: { type: 'STRING' }, nullable: true },
    pageCount: { type: 'INTEGER', nullable: true },
    header: {
      type: 'OBJECT',
      properties: Object.fromEntries(HEADER_KEYS.map((k) => [k, printedSchema])),
    },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: Object.fromEntries(LINE_KEYS.map((k) => [k, printedSchema])),
      },
    },
    otherCharges: {
      type: 'ARRAY',
      nullable: true,
      items: {
        type: 'OBJECT',
        properties: { label: { type: 'STRING' }, amount: { type: 'STRING', nullable: true } },
      },
    },
    otherPrinted: {
      type: 'ARRAY',
      nullable: true,
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          printed: { type: 'STRING', nullable: true },
          page: { type: 'INTEGER', nullable: true },
          box: { type: 'ARRAY', items: { type: 'INTEGER' }, nullable: true },
        },
      },
    },
  },
  required: ['invoiceCount', 'header', 'lines'],
};

export const GEMINI_PROMPT = `You read Indian GST purchase invoices for an accounts-payable system.
Copy every value EXACTLY as it is printed on the document, character for character, into "printed".
Read ONLY what is visibly printed on these pages. Never calculate, convert, complete, correct or guess
a value, and never fill one from a file name, a supplier you know, another invoice, an ERP, or what
invoices usually contain. If a value is not printed at all, return printed: null. If it is printed
but you cannot read it with certainty (smudged, cut off, covered by a stamp), return printed: null and
unreadable: true. Give the 1-based page number where you read it, and its box: [ymin, xmin, ymax,
xmax] on that page, each from 0 to 1000. When the pages are given as images, they are pages 1 to N
of ONE file, in order: read every page, not only the first.

Header fields:
- vendor*: the SELLER who issued the invoice (name, GSTIN, address, PAN). Not the buyer.
- buyerGstin, billingAddress: the BUYER ("Bill to"). shipTo*: the consignee ("Ship to").
- placeOfSupply: as printed (for example "Karnataka (29)" or "Karnataka, Code : 29").
- invoiceNumber, invoiceDate: the invoice's own number and date (not the e-way bill, IRN or Ack).
- poNumber: the buyer's purchase order number ("PO No", "Buyer's Order No", "Order No").
- taxable: the taxable value before tax as printed ("Taxable Value", "Basic Value", "Sub Total"); cgst, sgst, igst, cess: the tax AMOUNTS (not rates);
  roundOff: as printed including its sign, for example "(-)0.29"; total: the grand total.
Lines: one entry per item row, in printed order. quantity: only the number (for example "16,000.00");
uom: only the unit (for example "Nos"); rate: the unit price; discount: the discount amount;
taxable: the line's amount column ("Amount", "Taxable Value"; for quantity 1 it is printed the same
as the rate: give it in both); gstRate: the GST rate printed on the line (for example "18 %").
otherCharges: charges printed outside the item rows (freight, packing, insurance) with their amount.
otherPrinted: EVERY other labelled value printed on the invoice that has no field above, with its
label as printed (for a tax row under the items, such as "CGST @ 9%", give its tax amount, not the
value the tax is charged on), for example: buyer name, due date, IRN, Ack No, Ack Date, e-way bill number,
transporter, vehicle number, dispatch details, delivery note, payment terms, bank name, account
number, IFSC, currency, tax rate breakup, amount in words, notes, terms. Leave out what is not printed.
invoiceCount: how many separate invoices this file holds; invoiceNumbers: their numbers.
Ignore stamps, signatures and handwriting that are not part of the printed invoice.`;

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /**
   * Other models tried, in turn with the main one, when it is busy (HTTP 429/5xx) or not
   * available (HTTP 404). Google's busiest models are often "experiencing high demand".
   */
  backupModels?: readonly string[];
  /** The reader used when the AI cannot be reached or answers badly. */
  fallback: Extractor;
  timeoutMs?: number;
  /**
   * Waits before trying again when the AI service is busy or briefly failing (HTTP 429, 500,
   * 502, 503, 504, or the connection dropped). One retry per entry; then the local reader.
   */
  retryDelaysMs?: readonly number[];
  fetch?: typeof fetch;
  endpoint?: string;
}

type Field<T> = ExtractedField<T>;
/** Nothing read: a confident "not printed" (RULES §1.3), unless the AI says it could not read it. */
const empty = <T>(unreadable: boolean): Field<T> => ({
  value: null,
  confidenceBp: confidenceBp(unreadable ? 0 : AI_CONFIDENCE_BP),
  evidence: null,
  source: 'ai_vision',
});

/**
 * Each page's size, in the units evidence boxes use: PDF points (top-left origin, as the PDF text
 * reader) for a PDF, pixels for a photo. Without it, a value keeps its page and text but no box.
 */
export type PageSizes = ReadonlyMap<number, { width: number; height: number }>;

/** The model's 0–1000 box → [x, y, width, height] on the page; null when unusable. */
function bboxOf(
  page: number,
  box: readonly number[] | null | undefined,
  sizes: PageSizes,
): [number, number, number, number] | null {
  const size = sizes.get(page);
  if (!size || !box || box.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = box.map((v) => Math.min(1000, Math.max(0, v))) as [
    number,
    number,
    number,
    number,
  ];
  if (xmax <= xmin || ymax <= ymin) return null;
  const r = (v: number) => Math.round(v * 10) / 10;
  return [
    r((xmin / 1000) * size.width),
    r((ymin / 1000) * size.height),
    r(((xmax - xmin) / 1000) * size.width),
    r(((ymax - ymin) / 1000) * size.height),
  ];
}

/** One printed value → a field, accepted only if Veyrafy's parser accepts the printed text. */
function field<T>(
  p: Printed | undefined,
  parse: (text: string) => T | null,
  sizes: PageSizes = new Map(),
): Field<T> {
  const text = p?.printed?.replace(/\s+/g, ' ').trim();
  if (!text) return empty<T>(p?.unreadable === true);
  const page = p?.page ?? 1;
  const evidence = { page, text, bbox: bboxOf(page, p?.box, sizes) };
  const value = parse(text);
  return value === null
    ? { value: null, confidenceBp: confidenceBp(0), evidence, source: 'ai_vision' }
    : { value, confidenceBp: confidenceBp(AI_CONFIDENCE_BP), evidence, source: 'ai_vision' };
}

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/**
 * A GSTIN as printed: one that is not even GSTIN-shaped is kept (so the person sees what was read)
 * but always asked. The checksum is checked by the deterministic core, as for every reading.
 */
function gstinField(p: Printed | undefined, sizes: PageSizes): Field<string> {
  const f = field(p, (t) => t.replace(/[\s-]/g, '').toUpperCase(), sizes);
  if (f.value !== null && !GSTIN_SHAPE.test(f.value)) f.confidenceBp = confidenceBp(DOUBTFUL_BP);
  return f;
}

const money =
  (allowNegative = false) =>
  (t: string) =>
    parseAmount(t.replace(/^\(-\)\s*/, '-').replace(/\s*(Dr|Cr)\.?$/i, ''), allowNegative);
const text = (t: string) => t;
const date = (t: string) => parseDate(t);
const qty = (t: string) => {
  const r = parseQuantity(t.replace(/,/g, ''));
  return r.ok ? (r.value as number) : null;
};
const rate = (t: string) => {
  const r = parseRatePercent(t);
  return r.ok ? (r.value as number) : null;
};
const uom = (t: string) => normalizeUom(t);

/** Maps a validated AI reading to Veyrafy's extraction result (pure; tested on its own). */
export function toExtraction(
  reading: AiReading,
  version: string,
  sizes: PageSizes = new Map(),
): Pick<ExtractionResult, 'header' | 'lines' | 'warnings' | 'pages' | 'otherFields'> {
  const f = <T>(p: Printed | undefined, parse: (text: string) => T | null) =>
    field(p, parse, sizes);
  const h = reading.header as Record<(typeof HEADER_KEYS)[number], Printed | undefined>;
  const header: ExtractedHeader = {
    vendorName: f(h.vendorName, text),
    vendorGstin: gstinField(h.vendorGstin, sizes),
    vendorAddress: f(h.vendorAddress, text),
    vendorPan: f(h.vendorPan, (t) => t.replace(/\s/g, '').toUpperCase()),
    buyerGstin: gstinField(h.buyerGstin, sizes),
    billingAddress: f(h.billingAddress, text),
    placeOfSupply: f(h.placeOfSupply, text),
    shipToState: f(h.shipToState, text),
    shipToGstin: gstinField(h.shipToGstin, sizes),
    shipToAddress: f(h.shipToAddress, text),
    invoiceNumber: f(h.invoiceNumber, text),
    invoiceDate: f(h.invoiceDate, date),
    poNumber: f(h.poNumber, text),
    taxablePaise: f(h.taxable, money()),
    cgstPaise: f(h.cgst, money()),
    sgstPaise: f(h.sgst, money()),
    igstPaise: f(h.igst, money()),
    cessPaise: f(h.cess, money()),
    roundOffPaise: f(h.roundOff, money(true)),
    totalPaise: f(h.total, money()),
  } as ExtractedHeader;
  const lines = reading.lines.map((raw, i) => {
    const l = raw as Record<(typeof LINE_KEYS)[number], Printed | undefined>;
    return {
      lineNo: i + 1,
      description: f(l.description, text),
      vendorItemCode: f(l.itemCode, text),
      hsnSac: f(l.hsn, (t) =>
        /^\d{4,8}$/.test(t.replace(/\s/g, '')) ? t.replace(/\s/g, '') : null,
      ),
      qtyMilli: f(l.quantity, qty),
      uom: f(l.uom, uom),
      unitPricePaise: f(l.rate, money()),
      discountPaise: f(l.discount, money()),
      taxablePaise: f(l.taxable, money()),
      gstRateBp: f(l.gstRate, rate),
      cgstPaise: f(l.cgst, money()),
      sgstPaise: f(l.sgst, money()),
      igstPaise: f(l.igst, money()),
      lineTotalPaise: f(l.lineTotal, money()),
    } as ExtractedLine;
  });
  const warnings = [`Read by the AI reader (${version}); every value is checked by Veyrafy.`];
  const amounts = lineAmountsFromTotals(header, lines);
  if (amounts) warnings.push(amounts);
  const footer = footerRateFromPrinted(header, lines, reading.otherPrinted ?? [], sizes);
  if (footer) warnings.push(footer);
  for (const c of reading.otherCharges ?? [])
    warnings.push(
      `${c.label}${c.amount ? ` ${c.amount}` : ''} is printed outside the item lines; check it against the order.`,
    );
  // Everything else printed, as printed (never used to decide anything; nothing is thrown away).
  const otherFields: OtherPrintedField[] = [];
  for (const o of reading.otherPrinted ?? []) {
    const label = o.label.replace(/\s+/g, ' ').trim().slice(0, 200);
    const value = o.printed?.replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!label || !value || otherFields.length >= 300) continue;
    const page = o.page ?? 1;
    const shown = taxRowShown(label, value, header);
    otherFields.push({
      label: shown.label,
      value: shown.value,
      confidenceBp: confidenceBp(AI_CONFIDENCE_BP),
      evidence: { page, text: value, bbox: bboxOf(page, o.box, sizes) },
    });
  }
  // Charges printed outside the item lines (freight, packing…) are kept as printed too.
  for (const c of reading.otherCharges ?? []) {
    const label = c.label.replace(/\s+/g, ' ').trim().slice(0, 200);
    const value = c.amount?.replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!label || !value || otherFields.length >= 300) continue;
    otherFields.push({
      label,
      value,
      confidenceBp: confidenceBp(AI_CONFIDENCE_BP),
      evidence: { page: 1, text: `${label} ${value}`, bbox: null },
    });
  }
  return { header, lines, warnings, pages: reading.pageCount ?? 1, otherFields };
}

/**
 * A tax row under the items often prints the value the tax is charged on beside its label
 * ("CGST @ 9%   4780.00   430.20"). A value read beside the label that is not the tax read for that
 * head is never shown as if it were: it is named as the taxable value when it is the goods value,
 * and otherwise marked as not the tax read. The printed text itself is kept unchanged.
 */
export function taxRowShown(
  label: string,
  value: string,
  header: ExtractedHeader,
): { label: string; value: string } {
  const m = /\b(CGST|SGST|UTGST|IGST)\b[^%\d]{0,12}\d{1,2}(?:\.\d{1,2})?\s*%/i.exec(label);
  if (!m) return { label, value };
  const head = (m[1] ?? '').toUpperCase();
  const tax = (
    head === 'IGST'
      ? h(header.igstPaise)
      : head === 'CGST'
        ? h(header.cgstPaise)
        : h(header.sgstPaise)
  ) as number | null;
  const amounts = [...value.matchAll(/\d[\d,]*\.\d{2}/g)]
    .map((a) => parseAmount(a[0]))
    .filter((a): a is number => a !== null);
  if (tax === null || amounts.length === 0 || amounts.includes(tax)) return { label, value };
  const rupees = (p: number) => (p / 100).toFixed(2);
  const goods = h(header.taxablePaise) as number | null;
  if (amounts.length === 1 && amounts[0] === goods)
    return { label: `${label} · taxable value`, value: `${value} (tax ${rupees(tax)})` };
  return { label: `${label} · not the tax read`, value: `${value} (${head} read: ${rupees(tax)})` };
}
const h = (f: Field<unknown>) => f.value;

/**
 * A line amount the reading left "not printed" (not one it could not read: that stays not read),
 * filled only by a rule that is proven on the invoice itself, never from the ERP:
 *
 * - the amount column given as the line total, on an invoice with no per-line tax (Tally prints
 *   tax only in the footer: its one amount column is the line amount before tax); or
 * - quantity × rate, when that is exact to the paisa and the line has no discount.
 *
 * Applied only when every line then has an amount, the two rules never disagree on a line, and
 * the amounts add up EXACTLY to the invoice's own goods value (or, when none is printed, to its
 * total less its tax and round-off). Otherwise nothing changes and the amounts are asked. Returns
 * the explanation when it applied, else null.
 */
export function lineAmountsFromTotals(
  header: ExtractedHeader,
  lines: ExtractedLine[],
): string | null {
  const notPrinted = (f: Field<unknown>) =>
    f.value === null && f.evidence === null && f.confidenceBp > 0;
  const lineTax = lines.some(
    (l) => l.cgstPaise.value !== null || l.sgstPaise.value !== null || l.igstPaise.value !== null,
  );
  const filled = new Map<ExtractedLine, { paise: number; from: 'column' | 'qty_rate' }>();
  for (const l of lines) {
    if (l.taxablePaise.value !== null) continue;
    if (!notPrinted(l.taxablePaise)) return null;
    const column = !lineTax ? (l.lineTotalPaise.value as number | null) : null;
    const calc = exactProduct(
      l.qtyMilli.value as number | null,
      l.unitPricePaise.value as number | null,
      l.discountPaise.value as number | null,
    );
    if (column !== null && calc !== null && column !== calc) return null;
    if (column !== null) filled.set(l, { paise: column, from: 'column' });
    else if (calc !== null) filled.set(l, { paise: calc, from: 'qty_rate' });
    else return null;
  }
  if (filled.size === 0) return null;
  const sum = lines.reduce(
    (a, l) => a + ((l.taxablePaise.value as number | null) ?? filled.get(l)?.paise ?? 0),
    0,
  );
  const h = header;
  const goods = h.taxablePaise.value as number | null;
  const tax = [h.cgstPaise, h.sgstPaise, h.igstPaise, h.cessPaise].reduce(
    (a, f) => a + ((f.value as number | null) ?? 0),
    0,
  );
  const total = h.totalPaise.value as number | null;
  const proven =
    goods !== null
      ? goods === sum
      : total !== null && total === sum + tax + ((h.roundOffPaise.value as number | null) ?? 0);
  if (!proven) return null;
  const calculated: number[] = [];
  for (const [l, v] of filled) {
    if (v.from === 'column') {
      l.taxablePaise = { ...l.lineTotalPaise } as ExtractedLine['taxablePaise'];
      continue;
    }
    calculated.push(l.lineNo);
    // Calculated, not printed: the evidence says so, and points at the rate it came from.
    l.taxablePaise = {
      value: v.paise,
      confidenceBp: l.unitPricePaise.confidenceBp,
      evidence: l.unitPricePaise.evidence
        ? {
            ...l.unitPricePaise.evidence,
            text: `quantity × rate (${l.qtyMilli.evidence?.text ?? ''} × ${l.unitPricePaise.evidence.text})`,
          }
        : null,
      source: l.unitPricePaise.source,
    } as ExtractedLine['taxablePaise'];
  }
  const what = goods !== null ? 'the goods value printed' : 'the total less tax and round-off';
  return calculated.length
    ? `The amount of line${calculated.length === 1 ? '' : 's'} ${calculated.join(', ')} was not given separately: it is quantity × rate, exact to the paisa, and every line amount adds up exactly to ${what}.`
    : `The line amounts were read from the amount column; they add up exactly to ${what}.`;
}

/** quantity × rate in paise when exact to the paisa (no rounding), and no discount; else null. */
function exactProduct(
  qtyMilli: number | null,
  ratePaise: number | null,
  discountPaise: number | null,
): number | null {
  if (qtyMilli === null || ratePaise === null || qtyMilli <= 0 || ratePaise < 0) return null;
  if (discountPaise !== null && discountPaise !== 0) return null;
  const product = BigInt(qtyMilli) * BigInt(ratePaise);
  if (product % 1000n !== 0n) return null;
  const v = product / 1000n;
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

/**
 * The GST rate printed only in the footer ("CGST @ 9%", "SGST @ 9%"), as the AI reports it among
 * the other labelled values: given to every line only when no line has a rate of its own, the
 * footer names exactly one CGST and one SGST rate, equal, with equal CGST and SGST amounts (or
 * exactly one IGST rate and no CGST/SGST), and that rate gives EXACTLY the tax printed (see
 * footerRateProven: exempt lines, lines at another rate, or a second rate leave it asked).
 */
type Found = { printed: string; page: number; box: number[] | null };
export function footerRateFromPrinted(
  header: ExtractedHeader,
  lines: ExtractedLine[],
  other: AiReading['otherPrinted'],
  sizes: PageSizes = new Map(),
): string | null {
  if (lines.length === 0 || lines.some((l) => l.gstRateBp.value !== null || l.gstRateBp.evidence))
    return null;
  const found = {
    cgst: new Map<number, Found>(),
    sgst: new Map<number, Found>(),
    igst: new Map<number, Found>(),
  };
  for (const o of other ?? []) {
    const textOf = `${o.label} ${o.printed ?? ''}`.replace(/\s+/g, ' ');
    for (const m of textOf.matchAll(
      /\b(CGST|SGST|UTGST|IGST)\b[^%\d]{0,12}(\d{1,2}(?:\.\d{1,2})?)\s*%/gi,
    )) {
      const r = parseRatePercent(`${m[2]}%`);
      if (!r.ok) return null;
      const head = (m[1] ?? '').toLowerCase();
      const key = head === 'utgst' ? 'sgst' : (head as 'cgst' | 'sgst' | 'igst');
      found[key].set(r.value as number, { printed: m[0], page: o.page ?? 1, box: o.box ?? null });
    }
  }
  const h = header;
  let rateBp: number;
  let divisor: number;
  let printed: number | null;
  let evidence: Found;
  if (found.cgst.size === 1 && found.sgst.size === 1 && found.igst.size === 0) {
    const [[c, cp]] = [...found.cgst] as [[number, Found]];
    const [[g]] = [...found.sgst] as [[number, Found]];
    if (c !== g || h.cgstPaise.value === null || h.cgstPaise.value !== h.sgstPaise.value)
      return null;
    rateBp = c * 2;
    divisor = 20_000;
    printed = h.cgstPaise.value as number;
    evidence = cp;
  } else if (found.igst.size === 1 && found.cgst.size === 0 && found.sgst.size === 0) {
    const [[i, ip]] = [...found.igst] as [[number, Found]];
    rateBp = i;
    divisor = 10_000;
    printed = h.igstPaise.value as number | null;
    evidence = ip;
  } else return null;
  if (!footerRateProven(lines, rateBp, divisor, printed, h.taxablePaise.value as number | null))
    return null;
  const page = evidence.page;
  for (const l of lines)
    l.gstRateBp = {
      value: rateBp,
      confidenceBp: confidenceBp(AI_CONFIDENCE_BP),
      evidence: { page, text: evidence.printed, bbox: bboxOf(page, evidence.box, sizes) },
      source: 'ai_vision',
    } as ExtractedLine['gstRateBp'];
  return `GST rate ${rateBp / 100}% read from the tax printed under the items (${evidence.printed}) for every line: no line prints its own rate, and that rate gives exactly the tax printed.`;
}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

/** The document as the AI reader is given it. */
interface VisionDocument {
  parts: Part[];
  /** Bytes sent (before base64). */
  bytes: number;
  pages: number;
  sizes: PageSizes;
  /** Whether PDF pages were drawn as images because the PDF has no usable text. */
  rendered: boolean;
  /** A photo or image file (not a PDF). */
  image: boolean;
  /** Pages that were turned upright before being sent. */
  rotated: { page: number; rotation: Rotation }[];
}

/**
 * A PDF whose every page has a real text layer is sent as it is. A PDF with any page without one
 * (a scan, a photo saved as PDF, vector-drawn text) is sent as one image per page, every page, in
 * order: the reader always sees what a person sees, whatever the scanner stored. A photo is sent
 * as it is.
 */
async function visionDocument(bytes: Buffer, mime: string): Promise<VisionDocument> {
  const inline = (m: string, b: Buffer): Part => ({
    inline_data: { mime_type: m, data: b.toString('base64') },
  });
  if (mime !== 'application/pdf') {
    // A photo is sent upright; its size (for evidence boxes) is the upright image's.
    let photo = bytes;
    let size = imageSize(new Uint8Array(bytes));
    let rotation: Rotation = 0;
    if (mime === 'image/png' || mime === 'image/jpeg') {
      const up = await uprightImage(bytes, mime);
      photo = up.bytes;
      rotation = up.rotation;
      size = { width: up.width, height: up.height };
    }
    return {
      parts: [inline(mime, photo)],
      bytes: photo.length,
      pages: 1,
      sizes: new Map(size ? [[1, size]] : []),
      rendered: false,
      image: true,
      rotated: rotation ? [{ page: 1, rotation }] : [],
    };
  }
  const { pdfPagesForVision } = await import('../local/pdf');
  const { pages, rendered } = await pdfPagesForVision(new Uint8Array(bytes));
  const sizes = new Map(pages.map((p) => [p.page, { width: p.widthPt, height: p.heightPt }]));
  if (!rendered)
    return {
      parts: [inline(mime, bytes)],
      bytes: bytes.length,
      pages: pages.length,
      sizes,
      rendered,
      image: false,
      rotated: [],
    };
  const parts: Part[] = [];
  let total = 0;
  for (const p of pages) {
    if (!p.jpeg) throw new Error(`page ${p.page} was not drawn`);
    parts.push({ text: `Page ${p.page} of ${pages.length}:` }, inline('image/jpeg', p.jpeg));
    total += p.jpeg.length;
  }
  const rotated = pages
    .filter((p) => p.rotation)
    .map((p) => ({ page: p.page, rotation: p.rotation }));
  return { parts, bytes: total, pages: pages.length, sizes, rendered, image: false, rotated };
}

/**
 * What one reading used of the AI service, for Veyrafy's own cost accounting: every request made
 * (including retries and backup models) and the tokens the service reported for its answers. It
 * changes nothing about how the document is read.
 */
interface AiMeter {
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

class AiHttpError extends Error {
  constructor(
    readonly status: number,
    /** The AI service's own explanation (for the server log; never shown as is to people). */
    readonly detail: string = '',
    /** The model that was asked. */
    readonly model?: string,
  ) {
    super(`AI reader HTTP ${status}`);
  }
}

/** An answer that came back but cannot be used (cut off, empty, or not in the agreed shape). */
class AiAnswerError extends Error {
  constructor(
    readonly reason: string,
    readonly model?: string,
  ) {
    super(reason);
  }
}

/**
 * Why the AI reader could not be used, in words a person can act on (shown in the invoice's
 * history). Never the key, the request or the document.
 */
export function whyUnavailable(error: unknown, configured: string): string {
  const model =
    error instanceof AiHttpError || error instanceof AiAnswerError
      ? (error.model ?? configured)
      : configured;
  if (error instanceof AiHttpError) {
    const detail = error.detail ? ` (${error.detail})` : '';
    if (error.status === 404)
      return `the AI model "${model}" was not found; check VEYRA_AI_MODEL${detail}`;
    if (error.status === 401 || error.status === 403)
      return `the AI service refused the request (HTTP ${error.status}); check GEMINI_API_KEY${detail}`;
    if (error.status === 400) return `the AI service rejected the request (HTTP 400)${detail}`;
    if (error.status === 429) return `the AI service quota or rate limit was reached${detail}`;
    return `the AI service answered HTTP ${error.status}${detail}`;
  }
  if (error instanceof AiAnswerError)
    return `the AI service gave an unusable answer: ${error.reason}`;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return 'the AI service did not answer in time';
  if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError'))
    return 'the AI service gave an unusable answer';
  return 'the AI service could not be reached';
}

/** The AI service's error message, short, for the log (it never contains the key). */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } };
    return [body.error?.status, body.error?.message]
      .filter(Boolean)
      .join(': ')
      .replace(/\s+/g, ' ')
      .slice(0, 240);
  } catch {
    return '';
  }
}

export class GeminiExtractor implements Extractor {
  readonly id = 'ai_vision' as const;
  readonly version: string;
  readonly #o: Required<Omit<GeminiOptions, 'fallback'>> & { fallback: Extractor };
  /** The main model first, then the backups. */
  readonly #models: readonly string[];

  constructor(options: GeminiOptions) {
    this.#o = {
      timeoutMs: 90_000,
      retryDelaysMs: [2_000, 6_000, 15_000],
      fetch: globalThis.fetch,
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      backupModels: [],
      ...options,
    };
    this.#models = [...new Set([options.model, ...(options.backupModels ?? [])])];
    this.version = `gemini:${options.model}`;
  }

  /** The configured models, main first (names only: the key is never exposed). */
  get models(): readonly string[] {
    return this.#models;
  }

  async isAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.#o.apiKey ? { ok: true } : { ok: false, reason: 'No AI reader key is configured.' };
  }

  async extract(input: ExtractorInput): Promise<ExtractionResult> {
    let reading: AiReading;
    let model: string;
    let doc: VisionDocument;
    const meter: AiMeter = { model: null, calls: 0, inputTokens: 0, outputTokens: 0 };
    try {
      doc = await visionDocument(await readFile(input.filePath), input.mime);
      if (doc.bytes > MAX_INLINE_BYTES)
        return await this.#fallback(input, 'too large for it', meter);
      ({ reading, model } = await this.#readWithRetries(doc.parts, meter));
    } catch (error) {
      // Network, quota, timeout, an unusable answer or a file it cannot be given: never a reason
      // to lose the invoice. The local reader reads it (and fails only if nothing is readable).
      return this.#fallback(input, `unavailable (${whyUnavailable(error, this.#o.model)})`, meter);
    }
    if (reading.invoiceCount > 1) {
      const numbers = (reading.invoiceNumbers ?? []).filter(Boolean);
      throw new ExtractorError(
        'MULTIPLE_INVOICES',
        `This file seems to hold more than one invoice${numbers.length ? ` (${numbers.join(', ')})` : ''}. Upload each invoice as its own file.`,
      );
    }
    // The version names the model that actually read it (the main one or a backup).
    const version = `gemini:${model}`;
    const read = toExtraction(reading, version, doc.sizes);
    return {
      extractor: { id: this.id, version },
      ...read,
      // The page count is the document's own, never the model's.
      pages: doc.pages,
      warnings: [
        ...read.warnings,
        ...(doc.rendered
          ? ['The PDF has no readable text layer: every page was read as an image.']
          : []),
        ...doc.rotated.map((r) => rotationNote(r.page, r.rotation)),
      ],
      diagnostics: {
        readers: [this.id],
        textPages: doc.rendered || doc.image ? 0 : doc.pages,
        imagePages: doc.rendered || doc.image ? doc.pages : 0,
        rendered: doc.rendered,
        ai: { ...meter, model },
      },
    };
  }

  async #fallback(input: ExtractorInput, why: string, meter: AiMeter): Promise<ExtractionResult> {
    const result = await this.#o.fallback.extract(input);
    // Calls that were made before falling back are real usage too (a cut-off answer is billed).
    const ai = meter.calls > 0 ? { ai: { ...meter } } : {};
    return {
      ...result,
      warnings: [`The AI reader was ${why}; read by the local reader instead.`, ...result.warnings],
      ...(result.diagnostics
        ? {
            diagnostics: {
              ...result.diagnostics,
              readers: [this.id, ...result.diagnostics.readers],
              ...ai,
            },
          }
        : meter.calls > 0
          ? {
              // A fallback reader without diagnostics of its own: the AI usage is still kept.
              diagnostics: {
                readers: [this.id, result.extractor.id],
                textPages: 0,
                imagePages: 0,
                rendered: false,
                ...ai,
              },
            }
          : {}),
    };
  }

  /**
   * A busy or briefly failing AI service is tried again, with growing waits, before giving up.
   * With backup models, each try goes to the next model in turn (main, backup, main, …), so a
   * model that is overloaded does not hold the invoice up; a model that does not exist is dropped.
   */
  async #readWithRetries(
    parts: readonly Part[],
    meter: AiMeter = { model: null, calls: 0, inputTokens: 0, outputTokens: 0 },
  ): Promise<{ reading: AiReading; model: string }> {
    let models = this.#models;
    let round = 0;
    for (let turn = 0; ; turn++) {
      const model = models[turn % models.length] ?? this.#o.model;
      try {
        return { reading: await this.#read(parts, model, meter), model };
      } catch (error) {
        if (error instanceof AiHttpError && error.status === 404 && models.length > 1) {
          models = models.filter((m) => m !== model);
          turn--; // the same position now holds the next model
          continue;
        }
        const transient =
          (error instanceof AiHttpError && [429, 500, 502, 503, 504].includes(error.status)) ||
          error instanceof TypeError; // fetch: the connection failed or dropped
        if (!transient) throw error;
        // Straight on to the next model; after every model failed once, wait, then a new round.
        if (turn % models.length !== models.length - 1) continue;
        const wait = this.#o.retryDelaysMs[round++];
        if (wait === undefined) throw error;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  async #read(parts: readonly Part[], model: string, meter?: AiMeter): Promise<AiReading> {
    if (meter) {
      meter.calls += 1;
      meter.model = model;
    }
    const res = await this.#o.fetch(
      `${this.#o.endpoint}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        // The key goes in a header, never in the URL (URLs end up in logs).
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#o.apiKey },
        signal: AbortSignal.timeout(this.#o.timeoutMs),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [...parts, { text: GEMINI_PROMPT }] }],
          generationConfig: {
            temperature: 0,
            // Room for a long invoice with every value, its place and everything else printed.
            maxOutputTokens: 32_768,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_RESPONSE_SCHEMA,
          },
        }),
      },
    );
    if (!res.ok) throw new AiHttpError(res.status, await errorDetail(res), model);
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    // Tokens the service reports for this answer: counted even when the answer is then refused
    // (cut off, empty, not the agreed shape), because it was billed.
    if (meter && body.usageMetadata) {
      meter.inputTokens += Math.max(0, Math.round(body.usageMetadata.promptTokenCount ?? 0));
      meter.outputTokens += Math.max(0, Math.round(body.usageMetadata.candidatesTokenCount ?? 0));
    }
    const first = body.candidates?.[0];
    if (!first)
      throw new AiAnswerError(
        `no answer${body.promptFeedback?.blockReason ? ` (blocked: ${body.promptFeedback.blockReason})` : ''}`,
        model,
      );
    if (first.finishReason === 'MAX_TOKENS')
      throw new AiAnswerError('the answer was cut off', model);
    const answer = first.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!answer.trim())
      throw new AiAnswerError(
        `an empty answer (finish reason ${first.finishReason ?? 'unknown'})`,
        model,
      );
    let json: unknown;
    try {
      json = JSON.parse(answer);
    } catch {
      throw new AiAnswerError('the answer was not valid JSON', model);
    }
    const parsed = AiReadingSchema.safeParse(json);
    if (!parsed.success)
      throw new AiAnswerError(
        `the answer did not have the agreed shape (${parsed.error.issues[0]?.path.join('.') ?? ''}: ${parsed.error.issues[0]?.message ?? ''})`,
        model,
      );
    return parsed.data;
  }

  /**
   * A tiny request to see whether the AI reader works right now (for whoever sets Veyrafy up):
   * no document is sent. Each model is asked in turn until one answers. Plain-words result and
   * the technical reason; `skipped` names the models that did not answer, and why.
   */
  async test(): Promise<{
    ok: boolean;
    ms: number;
    model: string;
    reason: string | null;
    skipped: string[];
  }> {
    const started = Date.now();
    const skipped: string[] = [];
    let first: string | null = null;
    for (const model of this.#models) {
      try {
        const res = await this.#o.fetch(
          `${this.#o.endpoint}/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#o.apiKey },
            signal: AbortSignal.timeout(30_000),
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ready' }] }],
              generationConfig: { temperature: 0, maxOutputTokens: 256 },
            }),
          },
        );
        if (!res.ok) throw new AiHttpError(res.status, await errorDetail(res), model);
        return { ok: true, ms: Date.now() - started, model, reason: null, skipped };
      } catch (error) {
        const why = whyUnavailable(error, model);
        first ??= why;
        skipped.push(`${model}: ${why}`);
      }
    }
    return { ok: false, ms: Date.now() - started, model: this.#o.model, reason: first, skipped };
  }
}
