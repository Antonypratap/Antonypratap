import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExtractionResult } from '@veyra/shared';
import { LocalDocumentExtractor } from './local-extractor';
import type { PageText } from './layout';
import type { ExtractedLine } from '@veyra/shared';
import { footerRate, parseAmount, parseInvoice } from './parse';

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

  it('a value beside its label that starts like a label ("PO-2026-1103") is never cut short', () => {
    const seg = (text: string, x0: number, y0: number) => ({
      page: 1,
      text,
      x0,
      y0,
      x1: x0 + text.length * 6,
      y1: y0 + 10,
      conf: 100,
      source: 'pdf_text' as const,
    });
    const page: PageText = {
      page: 1,
      segments: [
        seg('TAX INVOICE', 250, 20),
        seg('Shakti Steel Suppliers Pvt Ltd', 20, 40),
        seg('Invoice No.', 20, 80),
        seg('INV-77', 120, 80),
        seg('PO No.', 20, 100),
        seg('PO-2026-1103', 120, 100),
        seg('Total', 300, 300),
        seg('1,180.00', 450, 300),
      ],
    };
    const po = parseInvoice([page]).header.poNumber;
    // Read in full, or asked: never "2026-1103".
    expect(po.value === 'PO-2026-1103' || (po.value === null && po.confidenceBp < 9000)).toBe(true);
  });

  it('the footer’s single GST rate is given to the lines only when it accounts for the tax', async () => {
    const r = await read('D15-tally-style.pdf');
    expect(r.lines.map((l) => l.gstRateBp.value)).toEqual([1800, 1800, 1800, 1800]);
    expect(r.lines[0]?.gstRateBp.evidence?.text).toMatch(/CGST @ 9%/);

    const seg = (text: string, x0: number, y0: number) => ({
      page: 1,
      text,
      x0,
      y0,
      x1: x0 + text.length * 6,
      y1: y0 + 10,
      conf: 100,
      source: 'pdf_text' as const,
    });
    const lines = () =>
      structuredClone(r.lines).map((l) => ({
        ...l,
        gstRateBp: { value: null, confidenceBp: 0, evidence: null, source: 'pdf_text' },
      })) as ExtractedLine[];
    const footer = [
      [seg('CGST @ 9%', 300, 400), seg('430.20', 450, 400)],
      [seg('SGST @ 9%', 300, 420), seg('430.20', 450, 420)],
    ];
    const proven = lines();
    footerRate(proven, footer, {
      taxable: { value: 478_000 },
      cgst: { value: 43_020 },
      sgst: { value: 43_020 },
      igst: { value: null },
    });
    expect(proven.map((l) => l.gstRateBp.value)).toEqual([1800, 1800, 1800, 1800]);
    // Tax that is not 9% + 9% of the goods (an exempt line, another rate): left not read.
    const off = lines();
    footerRate(off, footer, {
      taxable: { value: 478_000 },
      cgst: { value: 31_770 },
      sgst: { value: 31_770 },
      igst: { value: null },
    });
    expect(off.map((l) => l.gstRateBp.value)).toEqual([null, null, null, null]);
    // Two rates in the footer: no single rate for every line.
    const two = lines();
    footerRate(two, [...footer, [seg('CGST @ 2.5%', 300, 440), seg('10.00', 450, 440)]], {
      taxable: { value: 478_000 },
      cgst: { value: 43_020 },
      sgst: { value: 43_020 },
      igst: { value: null },
    });
    expect(two.map((l) => l.gstRateBp.value)).toEqual([null, null, null, null]);
  });

  it('the footer rate is never given to an exempt, differently rated or tiny line: asked instead', () => {
    const seg = (text: string, y0: number) => ({
      page: 1,
      text,
      x0: 300,
      y0,
      x1: 300 + text.length * 6,
      y1: y0 + 10,
      conf: 100,
      source: 'pdf_text' as const,
    });
    const rows = (cgst: string, sgst = cgst) => [
      [seg(`CGST @ ${cgst}`, 400)],
      [seg(`SGST @ ${sgst}`, 420)],
    ];
    const lines = (...amounts: number[]) =>
      amounts.map((value) => ({
        taxablePaise: { value, confidenceBp: 9900, evidence: null, source: 'pdf_text' },
        gstRateBp: { value: null, confidenceBp: 0, evidence: null, source: 'pdf_text' },
      })) as unknown as ExtractedLine[];
    const run = (ls: ExtractedLine[], footer: ReturnType<typeof rows>, half: number) => {
      const note = footerRate(ls, footer, {
        taxable: { value: null },
        cgst: { value: half },
        sgst: { value: half },
        igst: { value: null },
      });
      return { rates: ls.map((l) => l.gstRateBp.value), note };
    };
    // Taxed 10,000.00 + 5,000.00 at 18% (CGST 1,350.00): every line taxed, exactly.
    const ok = run(lines(1_000_000, 500_000), rows('9%'), 135_000);
    expect(ok.rates).toEqual([1800, 1800]);
    expect(ok.note).toMatch(/GST rate 18% read from the tax rows under the items/);
    // The same tax with an exempt line added, however small: never given 18%.
    for (const exempt of [5, 10, 100, 2_500, 100_000])
      expect(run(lines(1_000_000, 500_000, exempt), rows('9%'), 135_000).rates).toEqual([
        null,
        null,
        null,
      ]);
    // One paisa off: the rate does not account for the tax exactly.
    expect(run(lines(1_000_000, 500_000), rows('9%'), 135_001).rates).toEqual([null, null]);
    // CGST and SGST at different printed rates, or no rate printed: ambiguous.
    expect(run(lines(1_000_000), rows('9%', '6%'), 90_000).rates).toEqual([null]);
    expect(run(lines(1_000_000), [[seg('CGST', 400)], [seg('SGST', 420)]], 90_000).rates).toEqual([
      null,
    ]);
    // A low rate (0.25% GST): a line whose tax is within rounding of nothing is never given it.
    expect(run(lines(400_000, 400), rows('0.125%'), 500).rates).toEqual([null, null]);
  });
});
