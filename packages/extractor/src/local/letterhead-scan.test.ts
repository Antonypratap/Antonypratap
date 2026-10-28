import { describe, expect, it } from 'vitest';
import { wordsToSegments, withoutRules, type PageText } from './layout';
import { parseInvoice } from './parse';

/**
 * A small trader's boxed invoice as OCR returns a photographed page: the table's vertical rules
 * read as "|" stuck to words, registration lines (PAN, MSME/Udyam) printed above the supplier's
 * name, the name as the largest heading, "To," as the buyer label, and a tax summary box where each
 * head's tax amount sits a little below its supply value. Every name, number and amount is made up;
 * the layout follows a reported misread (the MSME line taken for the supplier, the supply value for
 * the SGST, no item lines read).
 */

type Word = { text: string; x0: number; h?: number };
/** One OCR line: words with their left edge; widths from the text, a common baseline. */
const line = (y: number, words: Word[]) => ({
  words: words.map((w) => ({
    text: w.text,
    x0: w.x0,
    x1: w.x0 + w.text.length * 6,
    y0: y,
    y1: y + (w.h ?? 10),
    conf: 90,
  })),
});

const page: PageText = {
  page: 1,
  segments: wordsToSegments(
    [
      line(20, [
        { text: 'GSTIN:', x0: 20 },
        { text: '29AAKCE3344D1ZP', x0: 62 },
        { text: 'TAX', x0: 290 },
        { text: 'INVOICE', x0: 312 },
      ]),
      line(35, [
        { text: '|PAN', x0: 20 },
        { text: 'No:', x0: 48 },
        { text: 'AAKCE3344D', x0: 70 },
      ]),
      line(50, [
        { text: '|', x0: 12 },
        { text: 'MSME', x0: 20 },
        { text: 'No:', x0: 50 },
        { text: 'UDYAM-KR-03-0001234', x0: 72 },
      ]),
      line(68, [
        { text: 'NEELA', x0: 200, h: 18 },
        { text: 'TRADING', x0: 238, h: 18 },
        { text: 'CO.', x0: 288, h: 18 },
      ]),
      line(92, [
        { text: 'No.12,', x0: 180 },
        { text: '4th', x0: 220 },
        { text: 'Cross,', x0: 242 },
        { text: 'Bengaluru', x0: 282 },
        { text: '560058', x0: 340 },
      ]),
      line(118, [
        { text: 'To,', x0: 20 },
        { text: 'Invoice', x0: 330 },
        { text: 'No.', x0: 376 },
        { text: ':', x0: 400 },
        { text: '21/2026-27', x0: 410 },
      ]),
      line(133, [
        { text: 'MADE-UP', x0: 20 },
        { text: 'BREWERIES', x0: 70 },
        { text: 'PVT', x0: 132 },
        { text: 'LTD', x0: 156 },
        { text: 'Date', x0: 330 },
        { text: ':', x0: 400 },
        { text: '04/04/2026', x0: 410 },
      ]),
      line(148, [
        { text: 'Kasaba', x0: 20 },
        { text: 'Hobli,', x0: 62 },
        { text: 'Bengaluru', x0: 102 },
        { text: 'Rural', x0: 160 },
      ]),
      line(170, [
        { text: 'GSTIN:', x0: 20 },
        { text: '29AAACS1111A1Z6', x0: 62 },
      ]),
      // The item table, every cell edged by a rule read as "|".
      line(200, [
        { text: '|No.', x0: 20 },
        { text: '|Particulars', x0: 60 },
        { text: '|HSN/SAC', x0: 250 },
        { text: '|Quantity', x0: 320 },
        { text: '|Rate', x0: 390 },
        { text: '|Tax', x0: 440 },
        { text: '%', x0: 466 },
        { text: '|Disc.', x0: 490 },
        { text: '|Amount|', x0: 540 },
      ]),
      line(222, [
        { text: '|1', x0: 24 },
        { text: 'Calcium', x0: 60 },
        { text: 'chloride', x0: 106 },
        { text: '500gm', x0: 158 },
        { text: '28272000', x0: 250 },
        { text: '|10', x0: 330 },
        { text: 'Nos', x0: 352 },
        { text: '284.00', x0: 390 },
        { text: '18.00', x0: 440 },
        { text: '2840.00|', x0: 540 },
      ]),
      line(244, [
        { text: '2', x0: 24 },
        { text: 'Calcium', x0: 60 },
        { text: 'sulphate', x0: 106 },
        { text: '500gm', x0: 158 },
        { text: '28332990', x0: 250 },
        { text: '2', x0: 336 },
        { text: 'Nos', x0: 352 },
        { text: '235.00', x0: 390 },
        { text: '18.00', x0: 440 },
        { text: '470.00', x0: 540 },
      ]),
      line(266, [
        { text: '3', x0: 24 },
        { text: 'Magnesium', x0: 60 },
        { text: 'sulphate', x0: 122 },
        { text: '500gm', x0: 174 },
        { text: '28332100', x0: 250 },
        { text: '4', x0: 336 },
        { text: 'Nos', x0: 352 },
        { text: '168.00', x0: 390 },
        { text: '18.00', x0: 440 },
        { text: '672.00|', x0: 540 },
      ]),
      line(320, [
        { text: 'Total', x0: 300 },
        { text: 'Qty.', x0: 334 },
        { text: '16.00', x0: 390 },
      ]),
      // Tax summary box: rate, supply value, and the tax amount a little lower.
      line(345, [
        { text: 'CGST', x0: 300 },
        { text: '9.00', x0: 350 },
        { text: '%', x0: 378 },
        { text: '3982.00', x0: 440 },
      ]),
      line(352, [{ text: '358.38', x0: 540 }]),
      line(362, [
        { text: 'SGST', x0: 300 },
        { text: '9.00', x0: 350 },
        { text: '%', x0: 378 },
        { text: '3982.00', x0: 440 },
      ]),
      line(369, [{ text: '358.38', x0: 540 }]),
      line(392, [
        { text: 'Round', x0: 440 },
        { text: 'Off', x0: 476 },
        { text: ':', x0: 500 },
        { text: '0.24', x0: 540 },
      ]),
      line(412, [
        { text: 'Grand', x0: 380 },
        { text: 'Total', x0: 416 },
        { text: 'Rs:', x0: 450 },
        { text: '4,699.00', x0: 540 },
      ]),
    ],
    1,
  ),
};

describe('boxed letterhead invoice, photographed (OCR)', () => {
  const r = parseInvoice([page]);

  it('removes the table rules OCR reads as characters, and nothing else', () => {
    expect(withoutRules('|Quantity')).toBe('Quantity');
    expect(withoutRules('2840.00|')).toBe('2840.00');
    expect(withoutRules('|')).toBe('');
    expect(withoutRules('A|B')).toBe('A|B');
    expect(withoutRules('1')).toBe('1');
  });

  it('takes the supplier name from the heading, never a registration line above it', () => {
    expect(r.header.vendorName.value).toBe('NEELA TRADING CO.');
    expect(r.header.vendorName.value).not.toMatch(/MSME|UDYAM|PAN/i);
  });

  it('reads the item lines whose cells are edged by rules', () => {
    expect(
      r.lines.map((l) => [l.qtyMilli.value, l.unitPricePaise.value, l.taxablePaise.value]),
    ).toEqual([
      [10_000, 28_400, 284_000],
      [2_000, 23_500, 47_000],
      [4_000, 16_800, 67_200],
    ]);
  });

  it('never takes the supply value for the tax: the tax amount, or not read', () => {
    for (const head of [r.header.cgstPaise, r.header.sgstPaise]) {
      expect(head.value).not.toBe(398_200);
      expect([null, 35_838]).toContain(head.value);
    }
    expect(r.header.totalPaise.value).toBe(469_900);
  });
});

describe('boxed letterhead invoice: parties and dates', () => {
  const r = parseInvoice([page]);

  it('takes "To," as the buyer label, so each GSTIN goes to its own party', () => {
    expect(r.header.vendorGstin.value).toBe('29AAKCE3344D1ZP');
    expect(r.header.buyerGstin.value).toBe('29AAACS1111A1Z6');
    expect(r.warnings.join(' ')).not.toMatch(/more than one supplier GSTIN/i);
  });

  it('reads the number and date whose ":" is printed apart from the label', () => {
    expect(r.header.invoiceNumber.value).toBe('21/2026-27');
    expect(r.header.invoiceDate.value).toBe('2026-04-04');
  });
});
