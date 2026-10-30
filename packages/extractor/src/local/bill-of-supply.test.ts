import { describe, expect, it } from 'vitest';
import { wordsToSegments, type PageText } from './layout';
import { parseInvoice } from './parse';

/**
 * A bill of supply (no GST charged) laid out with buyer and consignee side by side ("Buyers
 * Details", "Consignee / Ship To Details"), the order-number label just above the item table,
 * headings on two lines ("Sl" over "No", "HSN" over "/SAC"), an MSME number that is fifteen
 * characters, OCR scraps of a stamp above the supplier's name, and "!" read after the total.
 * Every name and number is made up.
 */
type W = { text: string; x0: number; x1?: number; h?: number; conf?: number };
const line = (y: number, words: W[]) => ({
  words: words.map((w) => ({
    text: w.text,
    x0: w.x0,
    x1: w.x1 ?? w.x0 + w.text.length * 6,
    y0: y,
    y1: y + (w.h ?? 10),
    conf: w.conf ?? 92,
  })),
});

const page: PageText = {
  page: 1,
  segments: wordsToSegments(
    [
      line(10, [{ text: 'Be', x0: 500, conf: 0 }]),
      line(14, [{ text: 'Wh', x0: 20, conf: 38 }]),
      line(24, [
        { text: 'TAX', x0: 200 },
        { text: 'INVOICE', x0: 222 },
        { text: '/', x0: 270 },
        { text: 'BILL', x0: 280 },
        { text: 'OF', x0: 308 },
        { text: 'SUPPLY', x0: 326 },
      ]),
      line(40, [
        { text: 'Hemanth', x0: 210 },
        { text: 'Foods', x0: 260 },
        { text: 'Pvt', x0: 296 },
        { text: 'Ltd', x0: 320 },
      ]),
      line(54, [
        { text: 'No', x0: 150 },
        { text: '4,', x0: 168 },
        { text: '1st', x0: 184 },
        { text: 'Cross,', x0: 206 },
        { text: 'Tumakuru', x0: 246 },
        { text: '572101', x0: 300 },
      ]),
      line(68, [
        { text: 'FSSAI', x0: 150 },
        { text: 'No:10012345678901', x0: 186 },
        { text: ',', x0: 294 },
        { text: 'MSME', x0: 302 },
        { text: 'No:KR07E0123456', x0: 334 },
      ]),
      line(82, [
        { text: 'GSTIN/UIN:29BBQPN1599K1ZO', x0: 150 },
        { text: ',', x0: 306 },
        { text: 'State', x0: 314 },
        { text: 'Name:', x0: 346 },
        { text: 'Karnataka', x0: 382 },
      ]),
      line(104, [
        { text: 'Buyers', x0: 20 },
        { text: 'Details', x0: 62 },
        { text: 'Consignee', x0: 300 },
        { text: '/', x0: 360 },
        { text: 'Ship', x0: 370 },
        { text: 'To', x0: 398 },
        { text: 'Details', x0: 414 },
      ]),
      line(118, [
        { text: 'MADE-UP', x0: 20 },
        { text: 'LABS', x0: 70 },
        { text: 'MADE-UP', x0: 300 },
        { text: 'LABS', x0: 350 },
      ]),
      line(132, [
        { text: 'Hebbal,', x0: 20 },
        { text: 'Mysuru', x0: 66 },
        { text: 'Hebbal,', x0: 300 },
        { text: 'Mysuru', x0: 346 },
      ]),
      line(146, [
        { text: 'GST', x0: 20 },
        { text: 'No:', x0: 44 },
        { text: '29AADCM1000R1ZE', x0: 66 },
        { text: 'GST', x0: 300 },
        { text: 'No:', x0: 324 },
        { text: '29AADCM1000R1ZE', x0: 346 },
      ]),
      line(170, [
        { text: 'Invoice', x0: 20 },
        { text: 'No', x0: 66 },
        { text: ':', x0: 84 },
        { text: '77/26-27', x0: 92 },
        { text: 'Dated', x0: 200 },
        { text: ':', x0: 236 },
        { text: '27-Apr-26', x0: 244 },
        { text: "Buyer's", x0: 310 },
        { text: 'Order', x0: 356 },
        { text: 'No.', x0: 392 },
      ]),
      line(184, [
        { text: 'Si', x0: 20 },
        { text: 'Description', x0: 60 },
        { text: 'of', x0: 130 },
        { text: 'Goods', x0: 146 },
        { text: 'HSN', x0: 250 },
        { text: 'GST', x0: 310 },
        { text: 'Qty', x0: 360 },
        { text: 'Rate', x0: 410 },
        { text: 'Per', x0: 460 },
        { text: 'Amount', x0: 510 },
      ]),
      line(196, [
        { text: 'No', x0: 20 },
        { text: '/SAC', x0: 248 },
      ]),
      line(212, [
        { text: '1', x0: 24 },
        { text: 'BRAND', x0: 60 },
        { text: 'CHEF', x0: 98 },
        { text: 'RICE', x0: 128 },
        { text: '30KG', x0: 158 },
        { text: '10064000', x0: 240 },
        { text: '20', x0: 364 },
        { text: '1,500.00', x0: 400 },
        { text: 'BAGS', x0: 458 },
        { text: '30,000.00', x0: 506 },
      ]),
      line(226, [{ text: 'BAG', x0: 60 }]),
      line(320, [
        { text: 'Taxable', x0: 250 },
        { text: 'Value', x0: 296 },
        { text: '30,000.00', x0: 506 },
      ]),
      line(350, [
        { text: 'TOTAL', x0: 440 },
        { text: '30,000.00!', x0: 506, conf: 60 },
      ]),
    ],
    1,
  ),
};

describe('a bill of supply with side-by-side parties and two-line headings', () => {
  const r = parseInvoice([page]);

  it("takes the supplier's name, never a low-confidence scrap above it", () => {
    expect(r.header.vendorName.value).toBe('Hemanth Foods Pvt Ltd');
  });

  it('"Buyers Details" is the buyer; a fifteen-character MSME number is not a GSTIN', () => {
    expect(r.header.vendorGstin.value).toBe('29BBQPN1599K1ZO');
    expect(r.header.buyerGstin.value).toBe('29AADCM1000R1ZE');
    expect(r.warnings.join(' ')).not.toMatch(/more than one supplier GSTIN/i);
  });

  it('reads the line under two-line headings, the order label above the table set aside', () => {
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
    ).toEqual([['BRAND CHEF RICE 30KG BAG', '10064000', 'BAGS', 20_000, 150_000, 3_000_000, null]]);
  });

  it('the total with "!" after it is read, and proven equal to the goods: no tax, no round-off', () => {
    expect(r.header.totalPaise.value).toBe(3_000_000);
    expect(r.header.totalPaise.confidenceBp).toBeGreaterThanOrEqual(9800);
    for (const f of [
      r.header.cgstPaise,
      r.header.sgstPaise,
      r.header.igstPaise,
      r.header.roundOffPaise,
    ]) {
      expect(f.value).toBeNull();
      expect(f.confidenceBp).toBeGreaterThanOrEqual(9800);
    }
  });

  it('the invoice number and date beside the order label are still read', () => {
    expect(r.header.invoiceNumber.value).toBe('77/26-27');
    expect(r.header.invoiceDate.value).toBe('2026-04-27');
  });
});
