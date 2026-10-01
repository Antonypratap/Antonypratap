import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ExtractionResultSchema, type ExtractionResult } from '@veyra/shared';
import { ExtractorError, type Extractor, type ExtractorInput } from '../extractor';
import {
  AI_CONFIDENCE_BP,
  GEMINI_RESPONSE_SCHEMA,
  GeminiExtractor,
  type AiReading,
} from './gemini';

/**
 * The AI reader is tested against a fake Gemini endpoint: what is sent, how every printed value is
 * re-checked by Veyrafy's own parsers, and that a failure never loses the invoice. All data made up.
 */
const dir = mkdtempSync(join(tmpdir(), 'veyra-ai-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'invoice.pdf');
writeFileSync(file, '%PDF-1.4 made-up');
const input: ExtractorInput = {
  documentId: 'd1',
  filePath: file,
  mime: 'application/pdf',
  sha256: 'x',
};

const p = (printed: string, page = 1) => ({ printed, page });
/** A made-up brewery-supplier invoice, as the model would return it. */
const READING: AiReading = {
  invoiceCount: 1,
  invoiceNumbers: ['MMH/26-27/0412'],
  pageCount: 1,
  header: {
    vendorName: p('Malabar Malt House Pvt Ltd'),
    vendorGstin: p('29AABCM2468K1Z4'),
    buyerGstin: p('29AAICH4826L1Z2'),
    invoiceNumber: p('MMH/26-27/0412'),
    invoiceDate: p('27-Sep-26'),
    poNumber: p('PO-2026-1103'),
    taxable: p('58,000.00'),
    cgst: p('5,220.00'),
    sgst: p('5,220.00'),
    roundOff: p('(-)0.29'),
    total: p('₹ 68,440.00'),
    igst: null,
  },
  lines: [
    {
      description: p('Pilsner Malt'),
      hsn: p('1107'),
      quantity: p('1,000.000'),
      uom: p('Kgs'),
      rate: p('58.00'),
      taxable: p('58,000.00'),
      gstRate: p('18 %'),
    },
  ],
  otherCharges: [{ label: 'Freight & Cartage', amount: '6,100.00' }],
};

function fakeGemini(answer: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }),
      { status },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const LOCAL: ExtractionResult = {
  extractor: { id: 'local_ocr', version: '1' },
  header: Object.fromEntries(
    [
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
      'taxablePaise',
      'cgstPaise',
      'sgstPaise',
      'igstPaise',
      'cessPaise',
      'roundOffPaise',
      'totalPaise',
    ].map((k) => [k, { value: null, confidenceBp: 0, evidence: null, source: 'tesseract' }]),
  ) as ExtractionResult['header'],
  lines: [],
  pages: 1,
  warnings: ['Page 1 is a scan: read by OCR.'],
};
const local: Extractor = {
  id: 'local_ocr',
  version: '1',
  isAvailable: async () => ({ ok: true }),
  extract: async () => LOCAL,
};
const reader = (fetch: typeof globalThis.fetch) =>
  new GeminiExtractor({
    apiKey: 'test-key-0123456789abcdef',
    model: 'gemini-test',
    fallback: local,
    fetch,
  });

describe('AI vision reader (Gemini)', () => {
  it('sends the original document with structured output; the key only in a header', async () => {
    const g = fakeGemini(READING);
    await reader(g.fetch).extract(input);
    const call = g.calls[0];
    expect(call?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent',
    );
    expect(call?.url).not.toContain('key');
    expect((call?.init.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'test-key-0123456789abcdef',
    );
    const body = JSON.parse(String(call?.init.body));
    expect(body.contents[0].parts[0].inline_data).toEqual({
      mime_type: 'application/pdf',
      data: Buffer.from('%PDF-1.4 made-up').toString('base64'),
    });
    expect(body.generationConfig).toMatchObject({
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: GEMINI_RESPONSE_SCHEMA,
    });
  });

  it('every printed value is re-parsed by Veyrafy; only what parses is confident', async () => {
    const r = await reader(fakeGemini(READING).fetch).extract(input);
    expect(ExtractionResultSchema.safeParse(r).success).toBe(true);
    expect(r.extractor).toEqual({ id: 'ai_vision', version: 'gemini:gemini-test' });
    expect(r.header.vendorGstin).toMatchObject({
      value: '29AABCM2468K1Z4',
      confidenceBp: AI_CONFIDENCE_BP,
      source: 'ai_vision',
      evidence: { page: 1, text: '29AABCM2468K1Z4', bbox: null },
    });
    expect(r.header.totalPaise).toMatchObject({ value: 6_844_000, confidenceBp: AI_CONFIDENCE_BP });
    expect(r.header.roundOffPaise.value).toBe(-29);
    // A two-digit year is never turned into a date (RULES §1.4): kept as evidence, asked.
    expect(r.header.invoiceDate).toMatchObject({
      value: null,
      confidenceBp: 0,
      evidence: { text: '27-Sep-26' },
    });
    // Not printed (an intra-state invoice has no IGST): a confident "absent".
    expect(r.header.igstPaise).toMatchObject({
      value: null,
      evidence: null,
      confidenceBp: AI_CONFIDENCE_BP,
    });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      lineNo: 1,
      hsnSac: { value: '1107' },
      qtyMilli: { value: 1_000_000 },
      uom: { value: 'KGS' },
      unitPricePaise: { value: 5800 },
      taxablePaise: { value: 5_800_000 },
      gstRateBp: { value: 1800 },
    });
    expect(r.warnings).toContain(
      'Freight & Cartage 6,100.00 is printed outside the item lines; check it against the order.',
    );
  });

  it('a value that is not what it claims (malformed GSTIN, unreadable amount) is always asked', async () => {
    const bad: AiReading = {
      ...READING,
      header: {
        ...READING.header,
        vendorGstin: p('29AABCM2468K1Z'),
        total: p('68,44O.00'),
        cgst: { printed: null, page: null, unreadable: true },
      },
    };
    const r = await reader(fakeGemini(bad).fetch).extract(input);
    expect(r.header.vendorGstin.confidenceBp).toBeLessThan(9000);
    expect(r.header.totalPaise).toMatchObject({ value: null, confidenceBp: 0 });
    // Printed but unreadable (under a stamp): nothing claimed, so it is asked.
    expect(r.header.cgstPaise).toMatchObject({ value: null, evidence: null, confidenceBp: 0 });
  });

  it('two invoices in one file are refused, never merged', async () => {
    const two = { ...READING, invoiceCount: 2, invoiceNumbers: ['A-1', 'A-2'] };
    const err = await reader(fakeGemini(two).fetch)
      .extract(input)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractorError);
    expect((err as ExtractorError).code).toBe('MULTIPLE_INVOICES');
    expect((err as Error).message).toMatch(/\(A-1, A-2\)\. Upload each invoice as its own file\./);
  });

  it('an error, a bad answer or no answer falls back to the local reader, and says so', async () => {
    for (const g of [
      fakeGemini({}, 503),
      fakeGemini({ nonsense: true }),
      {
        fetch: (async () => {
          throw new TypeError('network');
        }) as unknown as typeof fetch,
      },
    ]) {
      const r = await reader(g.fetch).extract(input);
      expect(r.extractor.id).toBe('local_ocr');
      expect(r.warnings[0]).toBe(
        'The AI reader was unavailable; read by the local reader instead.',
      );
    }
  });
});
