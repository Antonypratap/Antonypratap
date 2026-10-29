import { describe, expect, it } from 'vitest';
import { wordsToSegments, type PageText } from './layout';
import { gstinCheckOk, ocrGstin, parseAmount, parseInvoice } from './parse';

/**
 * A photographed boxed invoice with the OCR noise a real scan gives: a stray "=" and a smudge
 * read as "EEE" over the table headings, the serial number, item and HSN read as one run of words,
 * an item name that wraps under the serial column, a row number stuck to the item by a ruled line
 * ("3/…"), a comma after an amount ("358.38,"), a GSTIN with "0" read for "O", and the buyer's
 * GSTIN with its state code misread beside a printed "STATE: Karnataka". Every name and number is
 * made up.
 */
type W = { text: string; x0: number; x1?: number; h?: number };
const line = (y: number, words: W[]) => ({
  words: words.map((w) => ({
    text: w.text,
    x0: w.x0,
    x1: w.x1 ?? w.x0 + w.text.length * 6,
    y0: y,
    y1: y + (w.h ?? 10),
    conf: 90,
  })),
});
/** Words placed one after another with a word space, so OCR groups them as one run. */
const run = (y: number, x: number, texts: string[]) => {
  const words: W[] = [];
  for (const t of texts) {
    words.push({ text: t, x0: x });
    x += t.length * 6 + 6;
  }
  return line(y, words);
};

const page: PageText = {
  page: 1,
  segments: wordsToSegments(
    [
      line(20, [
        { text: 'GSTIN:', x0: 20 },
        { text: '29BBQPN1599K1Z0', x0: 62 },
        { text: 'TAX', x0: 290 },
        { text: 'INVOICE', x0: 312 },
      ]),
      line(60, [
        { text: 'KAVERI', x0: 200, h: 16 },
        { text: 'LAB', x0: 244, h: 16 },
        { text: 'SUPPLIES', x0: 268, h: 16 },
      ]),
      line(84, [
        { text: 'No.7,', x0: 180 },
        { text: '2nd', x0: 216 },
        { text: 'Main,', x0: 238 },
        // Fifteen letters, like a GSTIN's length: never taken for one.
        { text: 'Saraswathipuram', x0: 274 },
        { text: '570001', x0: 370 },
      ]),
      line(110, [{ text: 'To,', x0: 20 }]),
      line(114, [
        { text: 'INVOICE', x0: 300 },
        { text: 'No', x0: 346 },
        { text: '9/2026-27', x0: 420 },
      ]),
      line(128, [
        { text: 'Date', x0: 300 },
        { text: '05/04/2026', x0: 420 },
      ]),
      // A blank line, then the buyer's name: the block still starts here.
      line(142, [
        { text: 'MADE-UP', x0: 20 },
        { text: 'LABS', x0: 70 },
        { text: 'PVT', x0: 100 },
        { text: 'LTD', x0: 124 },
      ]),
      line(146, [
        { text: 'P.O', x0: 300 },
        { text: 'Date', x0: 322 },
        { text: '02/04/2026', x0: 420 },
      ]),
      line(158, [
        { text: 'Hebbal,', x0: 20 },
        { text: 'Mysuru', x0: 66 },
      ]),
      line(176, [
        { text: 'GSTIN:', x0: 20 },
        { text: '20AADCM1000R1ZE', x0: 62 },
        { text: 'STATE:', x0: 160 },
        { text: 'Karnataka', x0: 200 },
      ]),
      // Noise over the headings: a smudge over "No." and a flat "=" over "Quantity".
      line(195, [{ text: 'EEE', x0: 22, h: 8 }]),
      line(194, [{ text: '=', x0: 322, x1: 328, h: 1 }]),
      line(204, [
        { text: 'No.', x0: 20 },
        { text: 'Particulars', x0: 120 },
        { text: 'HSN/SAC', x0: 250 },
        { text: 'Quantity', x0: 320 },
        { text: 'Rate', x0: 400 },
        { text: 'Tax', x0: 440 },
        { text: '%', x0: 462 },
        { text: 'Amount', x0: 520 },
      ]),
      // Serial, item and HSN read as one run of words.
      run(226, 22, ['1', '122185-Potassium', 'nitrate', 'LR', '500gm', '28342110']),
      line(226, [
        { text: '10', x0: 330 },
        { text: 'Nos', x0: 346 },
        { text: '284.00', x0: 400 },
        { text: '18.00', x0: 440 },
        { text: '2840.00', x0: 520 },
      ]),
      // The item name wraps under the serial column; a ruled-line sliver read as "1".
      line(240, [{ text: 'Fisher', x0: 30 }]),
      line(244, [{ text: '1', x0: 300, x1: 301 }]),
      line(258, [
        { text: '2', x0: 24 },
        { text: 'Sodium', x0: 120 },
        { text: 'bicarbonate', x0: 162 },
        { text: '28363000', x0: 250 },
        { text: '2', x0: 336 },
        { text: 'Nos', x0: 346 },
        { text: '235.00,', x0: 400 },
        { text: '18.00', x0: 440 },
        { text: '470.00', x0: 520 },
      ]),
      line(282, [
        { text: '3/103711-ZINC', x0: 24 },
        { text: 'SULPHATE', x0: 110 },
        { text: '28332930', x0: 250 },
        { text: '4', x0: 336 },
        { text: 'Nos', x0: 346 },
        { text: '168.00', x0: 400 },
        { text: '18.00', x0: 440 },
        { text: '672.00', x0: 520 },
      ]),
      line(330, [
        { text: 'Total', x0: 300 },
        { text: 'Qty', x0: 334 },
        { text: '16.00', x0: 400 },
      ]),
      line(352, [
        { text: 'CGST', x0: 300 },
        { text: '9.00', x0: 350 },
        { text: '%', x0: 378 },
        { text: '3982.00', x0: 440 },
        { text: '358.38', x0: 520 },
      ]),
      line(368, [
        { text: 'SGST', x0: 300 },
        { text: '9.00', x0: 350 },
        { text: '%', x0: 378 },
        { text: '3982.00', x0: 440 },
        { text: '358.38,', x0: 520 },
      ]),
      line(400, [
        { text: 'Grand', x0: 380 },
        { text: 'Total', x0: 416 },
        { text: 'Rs:', x0: 450 },
        { text: '4,699.00', x0: 520 },
      ]),
    ],
    1,
  ),
};

describe('a photographed boxed invoice with OCR noise', () => {
  const r = parseInvoice([page]);

  it('reads every line in spite of the marks over the headings', () => {
    expect(
      r.lines.map((l) => [
        l.description.value,
        l.hsnSac.value,
        l.uom.value,
        l.qtyMilli.value,
        l.unitPricePaise.value,
        l.taxablePaise.value,
        l.gstRateBp.value,
      ]),
    ).toEqual([
      [
        '122185-Potassium nitrate LR 500gm Fisher',
        '28342110',
        'NOS',
        10_000,
        28_400,
        284_000,
        1800,
      ],
      ['Sodium bicarbonate', '28363000', 'NOS', 2_000, 23_500, 47_000, 1800],
      ['103711-ZINC SULPHATE', '28332930', 'NOS', 4_000, 16_800, 67_200, 1800],
    ]);
  });

  it('reads an amount with a comma after it, and both tax heads', () => {
    expect(parseAmount('358.38,')).toBe(35_838);
    expect(parseAmount('1,234,')).toBeNull();
    expect(r.header.cgstPaise.value).toBe(35_838);
    expect(r.header.sgstPaise.value).toBe(35_838);
    expect(r.header.totalPaise.value).toBe(469_900);
  });

  it('a GSTIN read with "0" for "O" is put right by its check character', () => {
    expect(r.header.vendorGstin.value).toBe('29BBQPN1599K1ZO');
    expect(r.warnings.join(' ')).not.toMatch(/more than one supplier GSTIN/i);
  });

  it("the buyer's GSTIN with a misread state code: recovered from the printed state", () => {
    expect(r.header.buyerGstin.value).toBe('29AADCM1000R1ZE');
  });

  it("the buyer's address stops before the invoice's details box beside it", () => {
    expect(r.header.billingAddress.value).toBe('Hebbal, Mysuru');
  });

  it('the invoice details beside the address are still read', () => {
    expect(r.header.invoiceNumber.value).toBe('9/2026-27');
    expect(r.header.invoiceDate.value).toBe('2026-04-05');
  });
});

describe('OCR-read GSTINs', () => {
  it('checks the check character', () => {
    expect(gstinCheckOk('29BBQPN1599K1ZO')).toBe(true);
    expect(gstinCheckOk('29BBQPN1599K1Z0')).toBe(false);
  });
  it.each([
    ['29BBQPN1599K1Z0', '29BBQPN1599K1ZO'],
    ['29BBQPNI599K1ZO', '29BBQPN1599K1ZO'],
    ['Z9BBQPN1599K1ZO', '29BBQPN1599K1ZO'],
    ['29BBQPN1599K12O', '29BBQPN1599K1ZO'],
  ])('%s → %s', (read, gstin) => expect(ocrGstin(read)).toBe(gstin));
  it('never guesses: a reading no fix makes valid is not read', () => {
    expect(ocrGstin('20AADCM1000R1ZE')).toBeNull();
    expect(ocrGstin('29BBQPN1599K1Z')).toBeNull();
  });
});

describe("values proven by the invoice's own checks", () => {
  const r = parseInvoice([page]);

  it('raises OCR values that agree to the paisa, and says so', () => {
    for (const f of [
      r.header.cgstPaise,
      r.header.sgstPaise,
      r.header.totalPaise,
      r.header.vendorGstin,
      ...r.lines.flatMap((l) => [l.qtyMilli, l.unitPricePaise, l.taxablePaise]),
    ])
      expect(f.confidenceBp).toBeGreaterThanOrEqual(9800);
    expect(r.warnings.join(' ')).toMatch(/Confirmed by the invoice's own checks/);
  });

  it('never raises a value that does not agree', () => {
    const off: PageText = {
      ...page,
      segments: page.segments.map((s) =>
        s.text === '4,699.00'
          ? { ...s, text: '4,999.00', words: [{ text: '4,999.00', conf: 70 }] }
          : s,
      ),
    };
    const o = parseInvoice([off]);
    expect(o.header.totalPaise.value).toBe(499_900);
    expect(o.header.totalPaise.confidenceBp).toBeLessThan(9000);
  });
});
