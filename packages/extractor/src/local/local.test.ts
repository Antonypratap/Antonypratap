import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { ExtractionResultSchema, parseMoney, type ExtractionResult } from '@veyra/shared';
import { ExtractorError } from '../extractor';
import { DOCUMENT_SAMPLES, BUYER, type DocumentSample } from '../samples/documents';
import { checkImageSize, imageSize } from './image';
import type { PageText, Segment } from './layout';
import { LocalDocumentExtractor, sniffDocument } from './local-extractor';
import { PDFJS_WASM_DIR, PDFJS_WASM_FILES, pdfDecodersAvailable } from './pdf';
import { OLLAMA_MAX_CONFIDENCE_BP, OllamaAssist } from './ollama';
import { parseAmount, parseDate, parseInvoice } from './parse';

const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
const extractor = new LocalDocumentExtractor();
afterAll(() => extractor.close());

const read = async (file: string): Promise<ExtractionResult> => {
  const bytes = new Uint8Array(readFileSync(new URL(file, DOCS)));
  const mime = sniffDocument(bytes);
  if (!mime) throw new Error(`not a document: ${file}`);
  return extractor.extractBytes(bytes, mime);
};

/** A text-layer segment at a position (for parser unit tests). */
const seg = (text: string, x0: number, y0: number, page = 1): Segment => ({
  page,
  text,
  x0,
  y0,
  x1: x0 + text.length * 6,
  y1: y0 + 10,
  conf: 100,
  source: 'pdf_text',
});

const minimalPage = (extra: Segment[] = [], page = 1): PageText => ({
  page,
  segments: [
    seg('TAX INVOICE', 250, 20, page),
    seg('Shakti Steel Suppliers Pvt Ltd', 20, 40, page),
    seg('GSTIN: 29AAFCS5678K1ZK', 20, 55, page),
    seg('Bill To:', 20, 90, page),
    seg('Veyra Demo Industries Pvt Ltd', 20, 105, page),
    seg('GSTIN: 29AAACS1111A1Z6', 20, 120, page),
    ...extra,
  ],
});

describe('deterministic parsers (RULES §1.1, §1.4)', () => {
  it('dates: only the listed day-first formats, real calendar dates, no two-digit years', () => {
    expect(parseDate('27/09/2026')).toBe('2026-09-27');
    expect(parseDate('27-09-2026')).toBe('2026-09-27');
    expect(parseDate('27.09.2026')).toBe('2026-09-27');
    expect(parseDate('27-Sep-2026')).toBe('2026-09-27');
    expect(parseDate('2026-09-27')).toBe('2026-09-27');
    for (const bad of ['27/09/26', '31/02/2026', '09/27/2026', 'Sep 27, 2026', ''])
      expect(parseDate(bad), bad).toBeNull();
  });

  it('amounts: Indian grouping, symbols, brackets; never rounded', () => {
    expect(parseAmount('₹ 1,13,870.00')).toBe(11_387_000);
    expect(parseAmount('Rs. 7,375')).toBe(737_500);
    expect(parseAmount('(0.40)', true)).toBe(-40);
    expect(parseAmount('-0.40')).toBeNull(); // negatives only where allowed (round-off)
    expect(parseAmount('562.505')).toBeNull(); // 3 decimals: unparseable, not rounded
    expect(parseAmount('5,6#2.50')).toBeNull();
    expect(parseMoney('562.50').ok).toBe(true);
  });
});

describe('parser: never guesses', () => {
  it('two different invoice numbers on one page: no value, both readings as evidence', () => {
    const r = parseInvoice([
      minimalPage([
        seg('Invoice No: SSS/26-27/0501', 300, 40),
        seg('Invoice No: SSS/26-27/0510', 300, 60),
      ]),
    ]);
    expect(r.header.invoiceNumber.value).toBeNull();
    expect(r.header.invoiceNumber.confidenceBp).toBe(0);
    expect(r.header.invoiceNumber.evidence?.text).toContain('0501');
    expect(r.header.invoiceNumber.evidence?.text).toContain('0510');
  });

  it('different invoice numbers on different pages: more than one invoice, never merged', () => {
    expect(() =>
      parseInvoice([
        minimalPage([seg('Invoice No: A-1', 300, 40)], 1),
        minimalPage([seg('Invoice No: A-2', 300, 40, 2)], 2),
      ]),
    ).toThrow(expect.objectContaining({ code: 'MULTIPLE_INVOICES' }) as ExtractorError);
  });

  it('two supplier GSTINs above the bill-to block: the supplier GSTIN is not chosen', () => {
    const r = parseInvoice([minimalPage([seg('GSTIN: 29AAKCE3344D1ZP', 20, 70)])]);
    expect(r.header.vendorGstin.value).toBeNull();
    expect(r.header.buyerGstin.value).toBe('29AAACS1111A1Z6');
  });

  it('a printed but unreadable total is kept as evidence, with no value', () => {
    const r = parseInvoice([
      minimalPage([
        seg('Description', 20, 150),
        seg('Qty', 200, 150),
        seg('Rate', 260, 150),
        seg('Amount', 330, 150),
        seg('Widget', 20, 170),
        seg('2', 210, 170),
        seg('10.00', 260, 170),
        seg('20.00', 330, 170),
        seg('Grand Total', 200, 200),
        seg('₹ 2#.0#', 330, 200),
      ]),
    ]);
    expect(r.lines).toHaveLength(1);
    expect(r.header.totalPaise.value).toBeNull();
    expect(r.header.totalPaise.evidence?.text).toContain('Grand Total');
    expect(r.warnings.join(' ')).toMatch(/total is printed but could not be read/);
  });

  it('a GSTIN label with a value that is not GSTIN-shaped keeps the reading, uncorrected', () => {
    const r = parseInvoice([
      {
        page: 1,
        segments: minimalPage().segments.map((s) =>
          s.text === 'GSTIN: 29AAACS1111A1Z6' ? { ...s, text: 'GSTIN: 29AAACS1111A176' } : s,
        ),
      },
    ]);
    expect(r.header.buyerGstin.value).toBe('29AAACS1111A176'); // the engine finds it unparseable
  });

  it('a document with no readable text is refused as malformed', () => {
    expect(() => parseInvoice([{ page: 1, segments: [] }])).toThrow(
      /no words were found on any page/,
    );
  });
});

describe('scanned PDFs from office scanners', () => {
  it('pdf.js image decoders (CCITT/JBIG2, JPEG 2000) are installed where the extractor runs', () => {
    expect(pdfDecodersAvailable()).toBe(true);
    for (const f of PDFJS_WASM_FILES)
      expect(readFileSync(`${PDFJS_WASM_DIR}${f}`).subarray(0, 4)).toEqual(
        Buffer.from([0x00, 0x61, 0x73, 0x6d]),
      );
  });

  it('a 600-dpi 1-bit CCITT G4 scan (Epson Scan 2 format) is decoded and read, never "No text could be read"', async () => {
    const pdf = readFileSync(new URL('D14-office-scan.pdf', DOCS)).toString('latin1');
    expect(pdf).toMatch(/\/Filter \/CCITTFaxDecode \/DecodeParms << \/K -1 .*\/BlackIs1 true/);
    expect(pdf).toMatch(/\/Width 49\d\d \/Height 70\d\d .*\/BitsPerComponent 1/);
    const r = await read('D14-office-scan.pdf');
    expect(r.warnings).toContain('Page 1 is a scan: read by OCR.');
    expect(r.header.vendorGstin.value).toBe('29AAFCS5678K1ZK');
    expect(r.header.invoiceNumber.value).toBe('SSS/26-27/0545');
    expect(r.header.poNumber.value).toBe('PO-2026-0110');
    expect(r.header.cgstPaise).toMatchObject({ value: 56_250 });
    expect(r.header.totalPaise).toMatchObject({ value: 737_500 });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      qtyMilli: { value: 100_000 },
      unitPricePaise: { value: 6250 },
      taxablePaise: { value: 625_000 },
    });
  }, 60_000);
});

describe('document safety', () => {
  it('type comes from the bytes, never the name', () => {
    expect(sniffDocument(new TextEncoder().encode('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffDocument(new TextEncoder().encode('<html>'))).toBeNull();
    expect(sniffDocument(Uint8Array.of(0x4d, 0x5a, 0x90, 0x00))).toBeNull(); // an .exe
  });

  it('image size is read from the header and refused before decoding', () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 50_000);
    new DataView(png.buffer).setUint32(20, 50_000);
    expect(imageSize(png)).toEqual({ width: 50_000, height: 50_000 });
    expect(() => checkImageSize(imageSize(png))).toThrow(/pixels/);
    expect(() => checkImageSize(null)).toThrow(/could not be read/);
  });

  it('a damaged PDF fails as malformed', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Garbage >>\ntrailer\n%%EOF\n');
    await expect(extractor.extractBytes(bytes, 'application/pdf')).rejects.toMatchObject({
      code: 'MALFORMED_DOCUMENT',
    });
  });

  it('a PDF with more pages than allowed fails without being read', async () => {
    const pages = 21;
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${pages} >>`,
      ...Array.from(
        { length: pages },
        () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>',
      ),
    ];
    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(body.length);
      body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = body.length;
    body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    await expect(
      extractor.extractBytes(new TextEncoder().encode(body), 'application/pdf'),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
  });

  it('a corrupt image fails as malformed', async () => {
    const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3, 4);
    await expect(extractor.extractBytes(bytes, 'image/jpeg')).rejects.toBeInstanceOf(
      ExtractorError,
    );
  });
});

// ── Real documents through the real pipeline (pdf.js + Tesseract) ──────────────

/** Header values as printed on a sample, in canonical form. */
function truth(sample: DocumentSample) {
  const inv = sample.invoices[0];
  if (!inv) throw new Error('sample without invoice');
  const money = (s: string | undefined) => (s === undefined ? null : parseAmount(s));
  return {
    vendorName: inv.vendor.name,
    vendorGstin: inv.vendor.gstin,
    buyerGstin: BUYER.gstin,
    invoiceNumber: inv.number,
    invoiceDate: parseDate(inv.date),
    poNumber: inv.po,
    placeOfSupply: inv.placeOfSupply,
    taxablePaise: money(inv.taxable),
    cgstPaise: money(inv.cgst),
    sgstPaise: money(inv.sgst),
    igstPaise: money(inv.igst),
    totalPaise: money(inv.total),
  } as Record<string, unknown>;
}

describe('real documents (fixtures/documents): what is confident is correct', () => {
  for (const sample of DOCUMENT_SAMPLES.filter((s) => s.expect.state !== 'FAILED')) {
    it(`${sample.file}: every value read at ≥ 0.90 is exactly what is printed`, async () => {
      const r = await read(sample.file);
      expect(ExtractionResultSchema.safeParse(r).success).toBe(true);
      const want = truth(sample);
      for (const [key, expected] of Object.entries(want)) {
        const f = r.header[key as keyof typeof r.header];
        if (f.value !== null && f.confidenceBp >= 9000)
          expect(f.value, `${sample.file} ${key}`).toEqual(expected);
        if (f.value !== null) expect(f.evidence, `${key} has evidence`).not.toBeNull();
      }
      const lines = sample.invoices[0]?.lines ?? [];
      for (const [i, l] of r.lines.entries()) {
        const printed = lines[i];
        if (!printed) throw new Error(`${sample.file}: an extra line was read`);
        if (l.unitPricePaise.value !== null && l.unitPricePaise.confidenceBp >= 9000)
          expect(l.unitPricePaise.value).toBe(parseAmount(printed.rate));
        if (l.taxablePaise.value !== null && l.taxablePaise.confidenceBp >= 9000)
          expect(l.taxablePaise.value).toBe(parseAmount(printed.taxable));
        if (l.hsnSac.value !== null && l.hsnSac.confidenceBp >= 9000)
          expect(l.hsnSac.value).toBe(printed.hsn);
      }
    }, 60_000);
  }

  it('text PDF: read exactly from the text layer, every field, source pdf_text', async () => {
    const r = await read('D01-clean-text.pdf');
    const want = truth(DOCUMENT_SAMPLES[0] as DocumentSample);
    for (const [key, expected] of Object.entries(want)) {
      const f = r.header[key as keyof typeof r.header];
      expect(f.value, key).toEqual(expected);
      if (expected !== null) expect([f.confidenceBp, f.source]).toEqual([9900, 'pdf_text']);
    }
    expect(r.header.vendorPan.value).toBe('AAFCS5678K');
    expect(r.header.shipToState.value).toBe('Karnataka (29)');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      description: { value: 'MS Steel Rod 12mm' },
      vendorItemCode: { value: 'SR-12' },
      hsnSac: { value: '7214' },
      qtyMilli: { value: 100_000 },
      uom: { value: 'KGS' },
      unitPricePaise: { value: 6250 },
      discountPaise: { value: 0 },
      gstRateBp: { value: 1800 },
      taxablePaise: { value: 625_000 },
    });
    expect(r.extractor.id).toBe('local_ocr');
  });

  it('scanned PDF, JPEG and PNG are read by Tesseract, with per-value confidence', async () => {
    for (const file of ['D02-scanned.pdf', 'D03-photo.jpg', 'D04-photo.png']) {
      const r = await read(file);
      expect(r.header.invoiceNumber.source, file).toBe('tesseract');
      expect(r.header.taxablePaise.value, file).not.toBeNull();
      expect(r.lines.length, file).toBe(1);
    }
  }, 60_000);

  it('multi-page PDF: lines from both pages, totals from page 2', async () => {
    const r = await read('D10-multi-page.pdf');
    expect(r.pages).toBe(2);
    expect(r.lines.map((l) => l.description.value)).toEqual([
      'MS Steel Rod 12mm',
      'MS Steel Plate 6mm',
    ]);
    expect(r.header.totalPaise).toMatchObject({ value: 11_387_000, evidence: { page: 2 } });
  });

  it('two invoices in one file are refused, naming both', async () => {
    await expect(read('D11-two-invoices.pdf')).rejects.toMatchObject({
      code: 'MULTIPLE_INVOICES',
      message: expect.stringMatching(/SSS\/26-27\/0530, SSS\/26-27\/0531/) as string,
    });
  });

  it('the smudged total is not invented', async () => {
    const r = await read('D06-unreadable-total.pdf');
    expect(r.header.totalPaise.value).toBeNull();
    expect(r.header.taxablePaise.value).toBe(1_125_000);
  });
});

describe('optional Ollama assist: grounded, capped, never decisive', () => {
  const pages: PageText[] = [minimalPage([seg('Ref: KTH-9999 dated 26/09/2026', 300, 40)])];
  const base = parseInvoice(pages);
  const ollama = (response: unknown, ok = true) =>
    new OllamaAssist({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'test',
      fetch: (async () =>
        ({
          ok,
          status: ok ? 200 : 500,
          json: async () => ({ response: JSON.stringify(response) }),
        }) as Response) as typeof fetch,
    });

  it('a quoted value printed on the document is proposed below the threshold, marked ollama', async () => {
    const r = await ollama({ invoiceNumber: 'KTH-9999', invoiceDate: '26/09/2026' }).fill(
      base,
      pages,
    );
    expect(r.header.invoiceNumber).toMatchObject({ value: 'KTH-9999', source: 'ollama' });
    expect(r.header.invoiceNumber.confidenceBp).toBeLessThanOrEqual(OLLAMA_MAX_CONFIDENCE_BP);
    expect(r.header.invoiceDate.value).toBe('2026-09-26');
  });

  it('a value that is not printed is discarded (no invention)', async () => {
    const r = await ollama({ invoiceNumber: 'KTH-1234', totalPaise: '9,999.00' }).fill(base, pages);
    expect(r.header.invoiceNumber.value).toBeNull();
    expect(r.header.totalPaise.value).toBeNull();
  });

  it('fields the parser found (or found ambiguous) are never touched; failures only warn', async () => {
    const r = await ollama({ vendorName: 'Someone Else Ltd' }).fill(base, pages);
    expect(r.header.vendorName.value).toBe('Shakti Steel Suppliers Pvt Ltd');
    const down = await ollama({}, false).fill(base, pages);
    expect(down.header).toEqual(base.header);
    expect(down.warnings.join(' ')).toMatch(/not available/);
  });
});

describe('warm-up (Phase 7)', () => {
  it('loads the readers ahead of time and changes nothing about what is read', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../fixtures/documents/D01-clean-text.pdf', import.meta.url)),
    );
    const cold = new LocalDocumentExtractor();
    const warm = new LocalDocumentExtractor();
    try {
      await warm.warmUp({ ocr: false });
      expect(await warm.extractBytes(bytes, 'application/pdf')).toEqual(
        await cold.extractBytes(bytes, 'application/pdf'),
      );
    } finally {
      await cold.close();
      await warm.close();
    }
  });
});

describe('OCR image encoding (Phase 7)', () => {
  it('the PNG handed to the OCR engine holds exactly the greyscale pixels', async () => {
    const { decodeImage, encodePng, removeRules } = await import('./image');
    const { PNG } = await import('pngjs');
    for (const f of ['D03-photo.jpg', 'D04-photo.png', 'D05-blurry.jpg']) {
      const bytes = new Uint8Array(
        readFileSync(new URL(`../../../../fixtures/documents/${f}`, import.meta.url)),
      );
      const gray = removeRules(decodeImage(bytes, f.endsWith('.png') ? 'image/png' : 'image/jpeg'));
      const back = PNG.sync.read(Buffer.from(encodePng(gray)));
      expect([back.width, back.height]).toEqual([gray.width, gray.height]);
      const pixels = new Uint8Array(gray.width * gray.height);
      for (let i = 0; i < pixels.length; i++) pixels[i] = back.data[i * 4] ?? 0;
      expect(Buffer.compare(Buffer.from(pixels), Buffer.from(gray.data))).toBe(0);
    }
  });
});
