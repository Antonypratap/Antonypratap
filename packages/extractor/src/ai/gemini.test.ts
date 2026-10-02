import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { imageOnlyStripPdf } from '../local/image-only-pdf';

/**
 * The AI reader is tested against a fake Gemini endpoint: what is sent, how every printed value is
 * re-checked by Veyrafy's own parsers, and that a failure never loses the invoice. All data made up.
 */
const dir = mkdtempSync(join(tmpdir(), 'veyra-ai-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
/** A made-up text PDF (the brewery demo's clean invoice). */
const TEXT_PDF = readFileSync(new URL('brewery/B01-clean.pdf', DOCS));
const file = join(dir, 'invoice.pdf');
writeFileSync(file, TEXT_PDF);
const input: ExtractorInput = {
  documentId: 'd1',
  filePath: file,
  mime: 'application/pdf',
  sha256: 'x',
};
const inputOf = (name: string, bytes: Uint8Array): ExtractorInput => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { ...input, filePath: path };
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
    retryDelaysMs: [1, 1],
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
      data: TEXT_PDF.toString('base64'),
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
    for (const [g, why] of [
      [fakeGemini({}, 503), 'the AI service answered HTTP 503'],
      [fakeGemini({}, 404), 'the AI model "gemini-test" was not found; check VEYRA_AI_MODEL'],
      [fakeGemini({}, 403), 'the AI service refused the request (HTTP 403); check GEMINI_API_KEY'],
      [fakeGemini({}, 429), 'the AI service quota or rate limit was reached'],
      [
        fakeGemini({ nonsense: true }),
        'the AI service gave an unusable answer: the answer did not have the agreed shape (invoiceCount: Invalid input: expected number, received undefined)',
      ],
      [
        {
          fetch: (async () => {
            throw new TypeError('network');
          }) as unknown as typeof fetch,
        },
        'the AI service could not be reached',
      ],
    ] as const) {
      const r = await reader(g.fetch).extract(input);
      expect(r.extractor.id).toBe('local_ocr');
      // The reason is said, so it can be fixed (a wrong model name, a key, a quota).
      expect(r.warnings[0]).toBe(
        `The AI reader was unavailable (${why}); read by the local reader instead.`,
      );
    }
  });
  it('a scanned PDF (no text layer) is sent as page images, every page, never refused', async () => {
    const scan = inputOf('scan.pdf', readFileSync(new URL('D14-office-scan.pdf', DOCS)));
    const g = fakeGemini(READING);
    const r = await reader(g.fetch).extract(scan);
    const parts = JSON.parse(String(g.calls[0]?.init.body)).contents[0].parts;
    expect(parts[0]).toEqual({ text: 'Page 1 of 1:' });
    expect(parts[1].inline_data.mime_type).toBe('image/jpeg');
    expect(Buffer.from(parts[1].inline_data.data, 'base64').subarray(0, 3)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff]),
    );
    expect(parts.at(-1).text).toMatch(/Read ONLY what is visibly printed/);
    expect(r.extractor.id).toBe('ai_vision');
    expect(r.diagnostics).toEqual({
      readers: ['ai_vision'],
      textPages: 0,
      imagePages: 1,
      rendered: true,
    });
    expect(r.warnings).toContain(
      'The PDF has no readable text layer: every page was read as an image.',
    );
    expect(r.header.totalPaise.value).toBe(6_844_000);
  }, 60_000);

  it('a multi-page PDF without text: every page is sent, in order', async () => {
    const pdf = await imageOnlyStripPdf(
      new Uint8Array(readFileSync(new URL('D10-multi-page.pdf', DOCS))),
      2,
    );
    const g = fakeGemini({ ...READING, pageCount: 1 });
    const r = await reader(g.fetch).extract(inputOf('two-pages.pdf', pdf));
    const parts = JSON.parse(String(g.calls[0]?.init.body)).contents[0].parts;
    expect(parts.filter((x: { text?: string }) => x.text?.startsWith('Page '))).toEqual([
      { text: 'Page 1 of 2:' },
      { text: 'Page 2 of 2:' },
    ]);
    expect(r.pages).toBe(2); // the document's own count, never the model's
  }, 60_000);

  it('keeps where each value is printed, and everything else printed, as printed', async () => {
    const withBoxes: AiReading = {
      ...READING,
      header: {
        ...READING.header,
        total: { printed: '₹ 68,440.00', page: 1, box: [500, 600, 520, 900] },
      },
      otherPrinted: [
        { label: 'e-Way Bill No.', printed: '1812 3456 7890', page: 1, box: [100, 50, 110, 300] },
        { label: 'Terms of Payment', printed: '30 days', page: 1 },
        { label: 'IRN', printed: null, page: 1 },
      ],
    };
    const r = await reader(fakeGemini(withBoxes).fetch).extract(input);
    // The page in PDF points, top-left origin, as the PDF text reader's boxes.
    const bbox = r.header.totalPaise.evidence?.bbox ?? [];
    expect(bbox.map((v) => Math.round(v))).toEqual([358, 421, 179, 17]);
    expect(r.otherFields).toEqual([
      {
        label: 'e-Way Bill No.',
        value: '1812 3456 7890',
        confidenceBp: AI_CONFIDENCE_BP,
        evidence: { page: 1, text: '1812 3456 7890', bbox: expect.any(Array) as unknown },
      },
      {
        label: 'Terms of Payment',
        value: '30 days',
        confidenceBp: AI_CONFIDENCE_BP,
        evidence: { page: 1, text: '30 days', bbox: null },
      },
      {
        label: 'Freight & Cartage',
        value: '6,100.00',
        confidenceBp: AI_CONFIDENCE_BP,
        evidence: { page: 1, text: 'Freight & Cartage 6,100.00', bbox: null },
      },
    ]); // nothing is made up for a label with no value
    expect(ExtractionResultSchema.safeParse(r).success).toBe(true);
  });

  it('a busy AI service (503) is tried again before giving up; a refusal is not', async () => {
    let calls = 0;
    const busyTwice = (async () => {
      calls++;
      return calls <= 2
        ? new Response('{}', { status: 503 })
        : new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: JSON.stringify(READING) }] } }],
            }),
          );
    }) as unknown as typeof fetch;
    const r = await reader(busyTwice).extract(input);
    expect([calls, r.extractor.id]).toEqual([3, 'ai_vision']);

    let refused = 0;
    const forbidden = (async () => {
      refused++;
      return new Response('{}', { status: 403 });
    }) as unknown as typeof fetch;
    const fallback = await reader(forbidden).extract(input);
    expect([refused, fallback.extractor.id]).toEqual([1, 'local_ocr']);
  });

  it('one badly shaped value does not lose the reading: that value is asked, the rest kept', async () => {
    const odd = {
      ...READING,
      header: {
        ...READING.header,
        total: { printed: '₹ 68,440.00', page: 0, box: [1, 2, 3] }, // page 0 and a 3-number box
        cgst: { printed: 5220 }, // a number where text was agreed
      },
    };
    const r = await reader(fakeGemini(odd).fetch).extract(input);
    expect(r.extractor.id).toBe('ai_vision'); // not thrown away
    expect(r.header.totalPaise).toMatchObject({ value: 6_844_000, evidence: { bbox: null } });
    expect(r.header.cgstPaise).toMatchObject({ value: null, confidenceBp: 0 }); // asked
    expect(r.header.vendorGstin.value).toBe('29AABCM2468K1Z4');
  });

  it('an answer cut off by length is said precisely', async () => {
    const cut = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: '{"invoiceCount":1,"hea' }] },
              finishReason: 'MAX_TOKENS',
            },
          ],
        }),
      )) as unknown as typeof fetch;
    const r = await reader(cut).extract(input);
    expect(r.warnings[0]).toBe(
      'The AI reader was unavailable (the AI service gave an unusable answer: the answer was cut off); read by the local reader instead.',
    );
  });

  it('when the main model is busy, the backup model reads it at once; one not found is dropped', async () => {
    const asked: string[] = [];
    const busyMain = (async (url: string) => {
      const model = /models\/([^:]+):/.exec(url)?.[1] ?? '';
      asked.push(model);
      if (model === 'main-model') return new Response('{}', { status: 503 });
      if (model === 'gone-model') return new Response('{}', { status: 404 });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(READING) }] } }],
        }),
      );
    }) as unknown as typeof fetch;
    const g = new GeminiExtractor({
      apiKey: 'test-key-0123456789abcdef',
      model: 'main-model',
      backupModels: ['gone-model', 'backup-model'],
      fallback: local,
      fetch: busyMain,
      retryDelaysMs: [60_000], // never waited for: the backup answers in the same round
    });
    const r = await g.extract(input);
    expect(asked).toEqual(['main-model', 'gone-model', 'backup-model']);
    expect(r.extractor).toEqual({ id: 'ai_vision', version: 'gemini:backup-model' });

    const t = await g.test();
    expect(t).toMatchObject({ ok: true, model: 'backup-model' });
    expect(t.skipped).toEqual([
      'main-model: the AI service answered HTTP 503',
      'gone-model: the AI model "gone-model" was not found; check VEYRA_AI_MODEL',
    ]);
  });

  it('every model busy: tried in rounds, then the local reader, naming the model', async () => {
    let calls = 0;
    const busy = (async () => {
      calls++;
      return new Response('{}', { status: 503 });
    }) as unknown as typeof fetch;
    const r = await new GeminiExtractor({
      apiKey: 'test-key-0123456789abcdef',
      model: 'a-model',
      backupModels: ['b-model'],
      fallback: local,
      fetch: busy,
      retryDelaysMs: [1, 1],
    }).extract(input);
    expect([calls, r.extractor.id]).toEqual([6, 'local_ocr']); // 3 rounds of 2 models
  });
});
