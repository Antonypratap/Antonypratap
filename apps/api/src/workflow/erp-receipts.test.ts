import { describe, expect, it } from 'vitest';
import {
  normalizeReceipt,
  receiptComparison,
  type InvoiceSide,
  type RawReceiptRecord,
} from './erp-receipts';

/**
 * The receipt comparison on its own, for a footer-tax invoice: four lines of quantity 1, goods
 * value 4,780.00, CGST and SGST 430.20 each, round-off -0.40, total 5,640.00, printed order 684.
 * Made-up supplier; the ERP record lists the lines in another order, holds its own internal order
 * id, and (as goods receipts do) no line for the labour charge.
 */
type Line = InvoiceSide['lines'][number];
const line = (lineNo: number, description: string, amount: number | null, hsn: string): Line => ({
  lineNo,
  description,
  hsnSac: hsn,
  uom: 'NOS',
  qtyMilli: 1000,
  unitPricePaise: amount,
  taxablePaise: amount,
  gstRateBp: 1800,
});
const invoice = (over: Partial<InvoiceSide> = {}): InvoiceSide => ({
  vendorName: 'Sample Electrical & Hardware',
  vendorGstin: '29AABCM2468K1Z4',
  invoiceNumber: '13839',
  invoiceDate: '2025-12-09',
  poNumber: '684',
  taxablePaise: 478_000,
  cgstPaise: 43_020,
  sgstPaise: 43_020,
  igstPaise: null,
  roundOffPaise: -40,
  totalPaise: 564_000,
  freightPaise: null,
  lines: [
    line(1, 'MIRROR', 345_000, '7009'),
    line(2, 'WOOD SCREW 2”', 4_000, '7318'),
    line(3, 'GATTA', 4_000, '3926'),
    line(4, 'Coolie', 125_000, '9987'),
  ],
  ...over,
});
const item = (name: string, rate: string, hsn: string) => ({
  item_name: name,
  hsn_sac_code: hsn,
  uom: 'NOS',
  quantity: '1',
  basic_rate: rate,
  basic_amount: rate,
  cgst: (Number(rate) * 0.09).toFixed(2),
  sgst: (Number(rate) * 0.09).toFixed(2),
});
function erp(
  items = [
    item('GATTA', '40', '3926'),
    item('WOOD SCREW 2"', '40', '7318'),
    item('MIRROR', '3450', '7009'),
    item('COOLIE', '1250', '9987'),
  ],
) {
  const raw = {
    invoice_info: {
      grn_id: '1',
      grn_no: '9001',
      po_id: '55012',
      dc_no: '13839',
      grn_date: '10/12/2025',
      invoice_date: '2025-12-09',
      invoice_amount: '5640',
      vendor_name: 'SAMPLE ELECTRICAL AND HARDWARE',
    },
    items,
  } as unknown as RawReceiptRecord;
  return normalizeReceipt(raw);
}
const rowsOf = (r: ReturnType<typeof receiptComparison>) => r.comparison.rows;
const find = (r: ReturnType<typeof receiptComparison>, section: RegExp, label: string) =>
  rowsOf(r).find((x) => section.test(x.section) && x.label === label);

describe('receipt comparison of a footer-tax invoice', () => {
  it('every value matching is cleared; identical names match whatever the ERP order', () => {
    const r = receiptComparison(invoice(), erp());
    expect(r.comparison.verdict).toBe('cleared');
    expect(find(r, /MIRROR/, 'Item')).toMatchObject({ result: 'match', invoice: 'MIRROR' });
    expect(find(r, /MIRROR/, 'Amount')).toMatchObject({ result: 'match' });
    expect(find(r, /WOOD SCREW/, 'Item')?.result).toBe('match');
    expect(find(r, /Totals/, 'Goods value')).toMatchObject({ result: 'match' });
    expect(find(r, /arithmetic/, 'Line amounts add up to the goods value')?.result).toBe('match');
    // Negative round-off: 4,780.00 + 860.40 − 0.40 = 5,640.00.
    expect(find(r, /arithmetic/, 'Lines + tax + round-off = total')?.result).toBe('match');
    expect(find(r, /Totals/, 'Invoice total')?.result).toBe('match');
    expect(find(r, /arithmetic/, 'GST calculated from the rates')?.result).toBe('match');
  });

  it('the printed order number is never compared with the ERP’s internal id, nor needed', () => {
    const shown = find(receiptComparison(invoice(), erp()), /Purchase order/, 'Order');
    expect(shown).toMatchObject({
      invoice: '684',
      erp: 'ERP reference 55012',
      result: 'not_checked',
    });
    // An internal id that happens to equal the printed number is still not a match.
    const same = erp();
    same.poRef = '684';
    expect(find(receiptComparison(invoice(), same), /Purchase order/, 'Order')?.result).toBe(
      'not_checked',
    );
    // Not read: shown as not read, and the invoice is not held up for it.
    const unread = receiptComparison(invoice({ poNumber: null }), erp());
    expect(unread.unread).not.toContain('header.poNumber');
    expect(unread.comparison.verdict).toBe('cleared');
  });

  it('a genuine difference in rate, amount, quantity or item is reported', () => {
    const rate = erp();
    const mirror = rate.lines.find((l) => l.name === 'MIRROR');
    if (!mirror) throw new Error('fixture');
    mirror.ratePaise = 340_000;
    mirror.amountPaise = 340_000;
    const r = receiptComparison(invoice(), rate);
    expect(r.comparison.verdict).toBe('mismatch');
    expect(find(r, /MIRROR/, 'Rate')).toMatchObject({ result: 'mismatch', erp: '₹3,400.00' });
    expect(find(r, /MIRROR/, 'Amount')?.result).toBe('mismatch');
    expect(find(r, /Totals/, 'Goods value')?.result).toBe('mismatch');

    const qty = erp();
    const gatta = qty.lines.find((l) => l.name === 'GATTA');
    if (!gatta) throw new Error('fixture');
    gatta.qtyMilli = 2000;
    expect(find(receiptComparison(invoice(), qty), /GATTA/, 'Quantity')?.result).toBe('mismatch');

    // A different item at the same quantity and rate is never paired with MIRROR by them alone.
    const other = erp([
      item('GATTA', '40', '3926'),
      item('WOOD SCREW 2"', '40', '7318'),
      item('GLASS SHELF', '3450', '7009'),
      item('COOLIE', '1250', '9987'),
    ]);
    const o = receiptComparison(invoice(), other);
    expect(o.comparison.verdict).toBe('mismatch');
    const items = rowsOf(o).filter((x) => x.label === 'Item' && x.result === 'mismatch');
    expect(items.map((x) => [x.invoice, x.erp])).toEqual(
      expect.arrayContaining([
        ['MIRROR', null],
        [null, 'GLASS SHELF'],
      ]),
    );
  });

  it('a line amount not read stays not read: asked, never taken from the ERP', () => {
    const inv = invoice();
    const coolie = inv.lines[3];
    if (!coolie) throw new Error('fixture');
    coolie.taxablePaise = null;
    const r = receiptComparison(inv, erp());
    expect(r.comparison.verdict).toBe('incomplete');
    expect(find(r, /Coolie|COOLIE/, 'Amount')).toMatchObject({
      invoice: null,
      erp: '₹1,250.00',
      result: 'not_checked',
    });
    expect(r.unread).toContain('lines[4].taxablePaise');
    // The goods value printed is still compared as printed; the lines' sum is not invented.
    expect(find(r, /Totals/, 'Goods value')).toMatchObject({
      invoice: '₹4,780.00',
      result: 'match',
    });
    expect(find(r, /arithmetic/, 'Line amounts add up to the goods value')).toBeUndefined();
  });

  it('without a printed goods value, the lines’ sum is used and labelled as calculated', () => {
    const r = receiptComparison(invoice({ taxablePaise: null }), erp());
    expect(find(r, /Totals/, 'Goods value (sum of lines)')).toMatchObject({
      invoice: '₹4,780.00 calculated',
      result: 'match',
    });
  });

  it('line amounts that do not add up to the goods value printed are caught', () => {
    const r = receiptComparison(invoice({ taxablePaise: 488_000 }), erp());
    expect(find(r, /arithmetic/, 'Line amounts add up to the goods value')).toMatchObject({
      result: 'mismatch',
      invoice: '₹4,880.00',
      erp: '₹4,780.00 calculated',
    });
    expect(r.comparison.verdict).toBe('mismatch');
  });
});
