import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { ExtractionResultSchema } from '@veyra/shared';
import { LocalDocumentExtractor } from './local-extractor';
import { imageOnlyStripPdf } from './image-only-pdf';
import { pdfPagesForVision } from './pdf';

/**
 * PDFs with NO text layer that are not one page-sized scan image: the kind that used to fail with
 * "No text could be read from the document." Many scanners and "print to PDF" tools store a page
 * as horizontal strips (or tiles); the old reader OCR'd only the largest strip. Every page must
 * now be drawn as a whole and read. The documents are made from the synthetic fixtures (made-up
 * parties and amounts), so the expected values are known exactly.
 */
const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
const extractor = new LocalDocumentExtractor();
afterAll(() => extractor.close());

const fixture = (file: string) => new Uint8Array(readFileSync(new URL(file, DOCS)));

describe('a PDF with no text layer is read visually, never refused', () => {
  it('one page stored as image strips: every field, the line and the GST are read', async () => {
    const pdf = await imageOnlyStripPdf(fixture('D01-clean-text.pdf'), 1);
    expect(Buffer.from(pdf).toString('latin1')).not.toMatch(/\/Font|BT\s/); // no text at all
    const r = ExtractionResultSchema.parse(await extractor.extractBytes(pdf, 'application/pdf'));
    expect(r.warnings).toContain('Page 1 has no readable text layer: read as an image by OCR.');
    expect(r.diagnostics).toEqual({
      readers: ['local_ocr'],
      textPages: 0,
      imagePages: 1,
      rendered: true,
    });
    expect(r.header.vendorGstin.value).toBe('29AAFCS5678K1ZK');
    expect(r.header.invoiceNumber.value).toBe('SSS/26-27/0501');
    expect(r.header.poNumber.value).toBe('PO-2026-0110');
    expect(r.header.cgstPaise.value).toBe(56_250);
    expect(r.header.sgstPaise.value).toBe(56_250);
    expect(r.header.totalPaise.value).toBe(737_500);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      hsnSac: { value: '7214' },
      qtyMilli: { value: 100_000 },
      unitPricePaise: { value: 6250 },
      taxablePaise: { value: 625_000 },
    });
    for (const f of [r.header.totalPaise, r.lines[0]?.qtyMilli]) {
      if (!f) throw new Error('no line');
      expect(f.source).toBe('tesseract');
      expect(f.evidence?.bbox).not.toBeNull(); // where it was read is kept
    }
  }, 120_000);

  it('a two-page invoice with no text layer: both pages are read, lines and the total', async () => {
    const pdf = await imageOnlyStripPdf(fixture('D10-multi-page.pdf'), 2);
    const r = await extractor.extractBytes(pdf, 'application/pdf');
    expect(r.pages).toBe(2);
    expect(r.diagnostics).toMatchObject({ textPages: 0, imagePages: 2, rendered: true });
    expect(r.lines.map((l) => l.description.value)).toEqual([
      'MS Steel Rod 12mm',
      'MS Steel Plate 6mm',
    ]);
    expect(r.header.taxablePaise).toMatchObject({ value: 9_650_000, evidence: { page: 2 } });
    // OCR may fail to read the bold ₹ total: then it is left unresolved (asked), never guessed.
    const total = r.header.totalPaise;
    if (total.value === null) expect([total.confidenceBp, total.evidence?.page]).toEqual([0, 2]);
    else expect(total.value).toBe(11_387_000);
  }, 180_000);

  it('a text PDF is still read from its text, with nothing drawn', async () => {
    const r = await extractor.extractBytes(fixture('D01-clean-text.pdf'), 'application/pdf');
    expect(r.diagnostics).toEqual({
      readers: ['local_ocr'],
      textPages: 1,
      imagePages: 0,
      rendered: false,
    });
    expect(r.header.totalPaise).toMatchObject({ value: 737_500, source: 'pdf_text' });
  });

  it('for the AI reader: a text PDF goes as it is, a PDF without text as page images', async () => {
    const text = await pdfPagesForVision(fixture('D10-multi-page.pdf'));
    expect(text.rendered).toBe(false);
    expect(text.pages.map((p) => [p.page, p.hasText, p.jpeg])).toEqual([
      [1, true, null],
      [2, true, null],
    ]);
    const scan = await pdfPagesForVision(await imageOnlyStripPdf(fixture('D10-multi-page.pdf'), 2));
    expect(scan.rendered).toBe(true);
    expect(scan.pages).toHaveLength(2); // every page, never page 1 only
    for (const p of scan.pages) {
      expect(p.hasText).toBe(false);
      expect(p.jpeg?.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(p.widthPt).toBeCloseTo(595, -1);
      expect(p.heightPt).toBeCloseTo(842, -1);
    }
  }, 60_000);

  it('only a page with nothing on it at all fails, and says what was tried', async () => {
    const blank = new TextEncoder().encode(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
    );
    await expect(extractor.extractBytes(blank, 'application/pdf')).rejects.toMatchObject({
      code: 'MALFORMED_DOCUMENT',
      message: expect.stringMatching(/^Veyrafy couldn't read this invoice: .*read as an image/),
    });
  }, 60_000);
});
