import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExtractionResult } from '@veyra/shared';
import { LocalDocumentExtractor } from './local-extractor';
import { parseAmount } from './parse';

/**
 * A Tally-style tax invoice through the local reader: boxed header labels with the value below
 * ("Invoice No." beside "Dated", "Buyer's Order No."), "1 Nos" quantities beside a "per" column, a
 * "Basic Value" goods subtotal under the item rows, and "Round Off (-)0.40". D15 is the text PDF,
 * D16 the same page as an image-only scan (no text layer: read by OCR). Synthetic: a made-up
 * supplier and GSTINs, with the amounts of a reported invoice.
 */
const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
const extractor = new LocalDocumentExtractor();
afterAll(() => extractor.close());
const read = (file: string): Promise<ExtractionResult> =>
  extractor.extractBytes(new Uint8Array(readFileSync(new URL(file, DOCS))), 'application/pdf');

const HEADER = {
  invoiceNumber: '13839',
  invoiceDate: '2025-12-09',
  poNumber: '684',
  taxablePaise: 478_000,
  cgstPaise: 43_020,
  sgstPaise: 43_020,
  roundOffPaise: -40,
  totalPaise: 564_000,
} as const;
const LINES = [
  ['MIRROR', 345_000],
  ['WOOD SCREW 2”', 4_000],
  ['GATTA', 4_000],
  ['Coolie', 125_000],
] as const;

describe('Tally-style invoice, local reader', () => {
  it('parses Tally’s "(-)" negative amounts', () => {
    expect(parseAmount('(-)0.40', true)).toBe(-40);
    expect(parseAmount('(-)0.40')).toBeNull();
  });

  it('text PDF: every value read, confidently, with its evidence', async () => {
    const r = await read('D15-tally-style.pdf');
    for (const [k, v] of Object.entries(HEADER)) {
      const f = r.header[k as keyof typeof HEADER];
      expect({ k, value: f.value }).toEqual({ k, value: v });
      expect(f.confidenceBp).toBeGreaterThanOrEqual(9000);
    }
    // The goods subtotal ends the item table: it is not a fifth line, nor part of the last one.
    expect(r.lines).toHaveLength(4);
    LINES.forEach(([name, amount], i) => {
      const l = r.lines[i];
      expect(l?.description.value).toBe(name);
      expect(l?.qtyMilli.value).toBe(1000);
      expect(l?.taxablePaise.value).toBe(amount);
      expect(l?.taxablePaise.confidenceBp).toBeGreaterThanOrEqual(9000);
    });
    expect(r.lines.reduce((s, l) => s + (l.qtyMilli.value ?? 0), 0)).toBe(4000);
    expect(r.header.taxablePaise.evidence?.text).toMatch(/Basic Value/);
    expect(r.header.roundOffPaise.evidence?.text).toMatch(/\(-\)0\.40/);
    expect(r.header.taxablePaise.source).toBe('pdf_text');
  });

  it('scan without a text layer: read by OCR; a value not read with certainty is never guessed', async () => {
    const r = await read('D16-tally-style-scan.pdf');
    expect(r.header.totalPaise.source).toBe('tesseract');
    for (const [k, v] of Object.entries(HEADER)) {
      const f = r.header[k as keyof typeof HEADER];
      // Either the right value, or no value and not confident (asked, never filled in).
      if (f.value !== v) {
        expect({ k, value: f.value }).toEqual({ k, value: null });
        expect(f.confidenceBp).toBeLessThan(9000);
      }
    }
    for (const [i, [, amount]] of LINES.entries()) {
      const f = r.lines[i]?.taxablePaise;
      if (f?.value !== amount) expect(f?.confidenceBp ?? 0).toBeLessThan(9000);
    }
    expect(r.header.totalPaise.value).toBe(564_000);
  });
});
