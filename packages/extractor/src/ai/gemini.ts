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
import { parseAmount, parseDate } from '../local/parse';

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
const Box = z.array(z.number()).length(4).nullable().optional();
const Printed = z
  .object({
    printed: z.string().nullable(),
    page: z.number().int().positive().nullable(),
    unreadable: z.boolean().nullable().optional(),
    box: Box,
  })
  .nullable();
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
    .optional(),
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
    .optional(),
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
- taxable: the taxable value before tax as printed; cgst, sgst, igst, cess: the tax AMOUNTS (not rates);
  roundOff: as printed including its sign, for example "(-)0.29"; total: the grand total.
Lines: one entry per item row, in printed order. quantity: only the number (for example "16,000.00");
uom: only the unit (for example "Nos"); rate: the unit price; discount: the discount amount;
taxable: the line amount; gstRate: the GST rate (for example "18 %").
otherCharges: charges printed outside the item rows (freight, packing, insurance) with their amount.
otherPrinted: EVERY other labelled value printed on the invoice that has no field above, with its
label as printed, for example: buyer name, due date, IRN, Ack No, Ack Date, e-way bill number,
transporter, vehicle number, dispatch details, delivery note, payment terms, bank name, account
number, IFSC, currency, tax rate breakup, amount in words, notes, terms. Leave out what is not printed.
invoiceCount: how many separate invoices this file holds; invoiceNumbers: their numbers.
Ignore stamps, signatures and handwriting that are not part of the printed invoice.`;

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** The reader used when the AI cannot be reached or answers badly. */
  fallback: Extractor;
  timeoutMs?: number;
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
    otherFields.push({
      label,
      value,
      confidenceBp: confidenceBp(AI_CONFIDENCE_BP),
      evidence: { page, text: value, bbox: bboxOf(page, o.box, sizes) },
    });
  }
  return { header, lines, warnings, pages: reading.pageCount ?? 1, otherFields };
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
    const size = imageSize(new Uint8Array(bytes));
    return {
      parts: [inline(mime, bytes)],
      bytes: bytes.length,
      pages: 1,
      sizes: new Map(size ? [[1, size]] : []),
      rendered: false,
      image: true,
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
    };
  const parts: Part[] = [];
  let total = 0;
  for (const p of pages) {
    if (!p.jpeg) throw new Error(`page ${p.page} was not drawn`);
    parts.push({ text: `Page ${p.page} of ${pages.length}:` }, inline('image/jpeg', p.jpeg));
    total += p.jpeg.length;
  }
  return { parts, bytes: total, pages: pages.length, sizes, rendered, image: false };
}

export class GeminiExtractor implements Extractor {
  readonly id = 'ai_vision' as const;
  readonly version: string;
  readonly #o: Required<Omit<GeminiOptions, 'fallback'>> & { fallback: Extractor };

  constructor(options: GeminiOptions) {
    this.#o = {
      timeoutMs: 90_000,
      fetch: globalThis.fetch,
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      ...options,
    };
    this.version = `gemini:${options.model}`;
  }

  async isAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.#o.apiKey ? { ok: true } : { ok: false, reason: 'No AI reader key is configured.' };
  }

  async extract(input: ExtractorInput): Promise<ExtractionResult> {
    let reading: AiReading;
    let doc: VisionDocument;
    try {
      doc = await visionDocument(await readFile(input.filePath), input.mime);
      if (doc.bytes > MAX_INLINE_BYTES) return await this.#fallback(input, 'too large for it');
      reading = await this.#read(doc.parts);
    } catch {
      // Network, quota, timeout, an unusable answer or a file it cannot be given: never a reason
      // to lose the invoice. The local reader reads it (and fails only if nothing is readable).
      return this.#fallback(input, 'unavailable');
    }
    if (reading.invoiceCount > 1) {
      const numbers = (reading.invoiceNumbers ?? []).filter(Boolean);
      throw new ExtractorError(
        'MULTIPLE_INVOICES',
        `This file seems to hold more than one invoice${numbers.length ? ` (${numbers.join(', ')})` : ''}. Upload each invoice as its own file.`,
      );
    }
    const read = toExtraction(reading, this.version, doc.sizes);
    return {
      extractor: { id: this.id, version: this.version },
      ...read,
      // The page count is the document's own, never the model's.
      pages: doc.pages,
      warnings: doc.rendered
        ? [...read.warnings, 'The PDF has no readable text layer: every page was read as an image.']
        : read.warnings,
      diagnostics: {
        readers: [this.id],
        textPages: doc.rendered || doc.image ? 0 : doc.pages,
        imagePages: doc.rendered || doc.image ? doc.pages : 0,
        rendered: doc.rendered,
      },
    };
  }

  async #fallback(input: ExtractorInput, why: string): Promise<ExtractionResult> {
    const result = await this.#o.fallback.extract(input);
    return {
      ...result,
      warnings: [`The AI reader was ${why}; read by the local reader instead.`, ...result.warnings],
      ...(result.diagnostics
        ? {
            diagnostics: {
              ...result.diagnostics,
              readers: [this.id, ...result.diagnostics.readers],
            },
          }
        : {}),
    };
  }

  async #read(parts: readonly Part[]): Promise<AiReading> {
    const res = await this.#o.fetch(
      `${this.#o.endpoint}/models/${encodeURIComponent(this.#o.model)}:generateContent`,
      {
        method: 'POST',
        // The key goes in a header, never in the URL (URLs end up in logs).
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#o.apiKey },
        signal: AbortSignal.timeout(this.#o.timeoutMs),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [...parts, { text: GEMINI_PROMPT }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_RESPONSE_SCHEMA,
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`AI reader HTTP ${res.status}`);
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const answer = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return AiReadingSchema.parse(JSON.parse(answer));
  }
}
