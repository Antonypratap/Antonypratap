import { describe, expect, it } from 'vitest';
import {
  normalizeReceipt,
  pickRecord,
  receiptComparison,
  sameName,
  spellingDiffers,
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
  items: Record<string, unknown>[] = [
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
      erp: 'ERP internal reference 55012',
      result: 'not_compared',
    });
    // An internal id that happens to equal the printed number is still not a match.
    const same = erp();
    same.poRef = '684';
    expect(find(receiptComparison(invoice(), same), /Purchase order/, 'Order')?.result).toBe(
      'not_compared',
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

    // A different item, at another rate, is never paired with MIRROR: one unmatched row each.
    const other = erp([
      item('GATTA', '40', '3926'),
      item('WOOD SCREW 2"', '40', '7318'),
      item('GLASS SHELF', '3400', '7009'),
      item('COOLIE', '1250', '9987'),
    ]);
    const o = receiptComparison(invoice(), other);
    expect(o.comparison.verdict).toBe('mismatch');
    const items = rowsOf(o).filter((x) => x.label === 'Item' && x.result !== 'match');
    expect(items.map((x) => [x.invoice, x.erp, x.result])).toEqual([
      ['MIRROR', null, 'unmatched'],
      [null, 'GLASS SHELF', 'unmatched'],
    ]);
    expect(o.comparison).toMatchObject({ unmatched: 2, needsConfirmation: 0 });
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
      result: 'needs_confirmation',
    });
    // Not read is not a difference.
    expect(r.comparison.mismatched).toBe(0);
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

  it('a taxable value printed with the freight in it is not counted twice', () => {
    // One line of 10,000.00, freight 500.00, taxable value printed 10,500.00, GST 18% on it.
    const inv = invoice({
      taxablePaise: 1_050_000,
      cgstPaise: 94_500,
      sgstPaise: 94_500,
      roundOffPaise: 0,
      totalPaise: 1_239_000,
      freightPaise: 50_000,
      lines: [line(1, 'MIRROR', 1_000_000, '7009')],
    });
    const rec = erp([
      { ...item('MIRROR', '10000', '7009'), cgst: '945.00', sgst: '945.00', freight: '500' },
    ]);
    const r = receiptComparison(inv, rec);
    expect(find(r, /arithmetic/, 'Line amounts add up to the goods value')?.result).toBe('match');
    expect(find(r, /Totals/, 'Goods value')).toMatchObject({ result: 'match' });
    expect(find(r, /arithmetic/, 'Lines + tax + round-off = total')?.result).toBe('match');
    expect(find(r, /Totals/, 'Invoice total')?.result).toBe('match');
  });
});

/** Every row is counted exactly once, in exactly one state. */
function expectCountsFromRows(r: ReturnType<typeof receiptComparison>) {
  const c = r.comparison;
  const n = (result: string) => c.rows.filter((x) => x.result === result).length;
  expect({
    matched: c.matched,
    mismatched: c.mismatched,
    unmatched: c.unmatched,
    needsConfirmation: c.needsConfirmation,
    notCompared: c.notCompared,
  }).toEqual({
    matched: n('match'),
    mismatched: n('mismatch'),
    unmatched: n('unmatched'),
    needsConfirmation: n('needs_confirmation'),
    notCompared: n('not_compared'),
  });
  expect(c.matched + c.mismatched + c.unmatched + c.needsConfirmation + c.notCompared).toBe(
    c.rows.length,
  );
  // No row twice.
  const keys = c.rows.map((x) => `${x.section}/${x.label}`);
  expect(new Set(keys).size).toBe(keys.length);
}

describe('reconciliation states: match, mismatch, unmatched, to confirm, not compared', () => {
  it('the reported invoice: 3,450 + 40 + 40 + 1,250 = 4,780; 9% = 430.20 each; total 5,640', () => {
    const r = receiptComparison(invoice(), erp());
    expect(r.comparison.verdict).toBe('cleared');
    expect(r.comparison).toMatchObject({ mismatched: 0, unmatched: 0, needsConfirmation: 0 });
    expect(r.differences).toEqual([]);
    expectCountsFromRows(r);
    // Quantity total 4.
    expect(invoice().lines.reduce((a, l) => a + (l.qtyMilli ?? 0), 0)).toBe(4000);
  });

  it('a plural or a look-alike letter in the ERP’s item name is the same item, matched once', () => {
    expect(sameName('MIRROR', 'MIRRORS 18X24')).toBe(true);
    expect(sameName('MIRROR', 'МIRROR')).toBe(true); // Cyrillic М
    expect(sameName('BOX', 'BOXES')).toBe(true);
    expect(sameName('GLASS', 'GLAS')).toBe(false);
    expect(sameName('176x89mm envelope', '175x89mm envelope')).toBe(false);
    const r = receiptComparison(
      invoice(),
      erp([
        item('GATTA', '40', '3926'),
        item('WOOD SCREW 2"', '40', '7318'),
        item('MIRRORS 18X24', '3450', '7009'),
        item('COOLIE', '1250', '9987'),
      ]),
    );
    expect(r.comparison.verdict).toBe('cleared');
    const mirror = rowsOf(r).filter((x) => /MIRROR/.test(x.section));
    expect(mirror.find((x) => x.label === 'Item')).toMatchObject({
      invoice: 'MIRROR',
      erp: 'MIRRORS 18X24',
      result: 'match',
    });
    // Never also "missing on the ERP side" and "extra in the ERP".
    expect(rowsOf(r).filter((x) => x.result === 'unmatched')).toEqual([]);
  });

  it('an item the ERP names differently, with the same quantity, rate and amount: one row to confirm', () => {
    const r = receiptComparison(
      invoice(),
      erp([
        item('GATTA', '40', '3926'),
        item('WOOD SCREW 2"', '40', '7318'),
        item('MIR-1824 GLASS', '3450', '7009'),
        item('COOLIE', '1250', '9987'),
      ]),
    );
    expect(r.comparison.verdict).toBe('incomplete');
    expect(r.comparison).toMatchObject({ mismatched: 0, unmatched: 0, needsConfirmation: 1 });
    const items = rowsOf(r).filter((x) => x.label === 'Item' && x.result !== 'match');
    expect(items).toEqual([
      expect.objectContaining({
        invoice: 'MIRROR',
        erp: 'MIR-1824 GLASS',
        result: 'needs_confirmation',
      }),
    ]);
    // Never a match: its quantity, rate and amount rows are not ticked as if it were.
    expect(
      rowsOf(r)
        .filter((x) => /MIR-1824/.test(x.section))
        .map((x) => x.label),
    ).toEqual(['Item']);
    expect(r.differences).toEqual([
      expect.objectContaining({ label: 'Item', confirm: true, path: null }),
    ]);
    // Not a question about a value read: nothing is asked of the reading.
    expect(r.unread).toEqual([]);
    expectCountsFromRows(r);
  });

  it('a misspelt item name ("MIRRIOR") with the same values: to confirm, the spelling named', () => {
    const inv = invoice();
    (inv.lines[0] as Line).description = 'MIRRIOR';
    const r = receiptComparison(inv, erp());
    expect(r.comparison).toMatchObject({
      verdict: 'incomplete',
      mismatched: 0,
      unmatched: 0,
      needsConfirmation: 1,
    });
    const row = rowsOf(r).find((x) => x.label === 'Item' && x.result === 'needs_confirmation');
    expect(row).toMatchObject({ invoice: 'MIRRIOR', erp: 'MIRROR' });
    expect(row?.note).toMatch(/^The spelling differs \(MIRRIOR \/ MIRROR\), and quantity, rate/);
    // Never a match on spelling alone: a different amount leaves both items unmatched.
    const other = erp();
    const mirror = other.lines.find((l) => l.name === 'MIRROR');
    if (!mirror) throw new Error('fixture');
    mirror.ratePaise = 340_000;
    mirror.amountPaise = 340_000;
    const off = receiptComparison(inv, other);
    expect(off.comparison.unmatched).toBe(2);
    expect(
      rowsOf(off).filter((x) => x.label === 'Item' && /MIRR/.test(`${x.invoice}${x.erp}`)),
    ).toEqual([
      expect.objectContaining({ invoice: 'MIRRIOR', erp: null, result: 'unmatched' }),
      expect.objectContaining({ invoice: null, erp: 'MIRROR', result: 'unmatched' }),
    ]);
  });

  it('one letter apart: added, left out, changed or swapped; never for short or different words', () => {
    expect(spellingDiffers('MIRRIOR', 'MIRROR')).toBe(true);
    expect(spellingDiffers('MIROR', 'MIRROR')).toBe(true);
    expect(spellingDiffers('MIRRUR', 'MIRROR')).toBe(true);
    expect(spellingDiffers('MIRORR', 'MIRROR')).toBe(true);
    expect(spellingDiffers('MIRROR', 'MIRRORS')).toBe(false); // the same name
    expect(spellingDiffers('GATTA', 'BATTEN')).toBe(false);
    expect(spellingDiffers('BOLT', 'BELT')).toBe(false); // too short to tell
  });

  it('unrelated items that share a quantity and rate are never paired when it is ambiguous', () => {
    const inv = invoice({
      taxablePaise: 8_000,
      cgstPaise: 720,
      sgstPaise: 720,
      roundOffPaise: 0,
      totalPaise: 9_440,
      lines: [line(1, 'GATTA', 4_000, '3926'), line(2, 'WOOD SCREW 2”', 4_000, '7318')],
    });
    const r = receiptComparison(
      inv,
      erp([item('HINGE', '40', '8302'), item('TOWER BOLT', '40', '8302')]),
    );
    expect(r.comparison.verdict).toBe('mismatch');
    expect(
      rowsOf(r)
        .filter((x) => x.label === 'Item')
        .map((x) => x.result),
    ).toEqual(['unmatched', 'unmatched', 'unmatched', 'unmatched']);
    expect(rowsOf(r).some((x) => x.label === 'Item' && x.result === 'match')).toBe(false);
    expect(r.comparison.unmatched).toBe(4);
    expectCountsFromRows(r);
  });

  it('repeated item names pair one to one, by quantity, whatever the ERP order', () => {
    const inv = invoice({
      taxablePaise: 12_000,
      cgstPaise: 1_080,
      sgstPaise: 1_080,
      roundOffPaise: 0,
      totalPaise: 14_160,
      lines: [
        { ...line(1, 'WOOD SCREW 2”', 4_000, '7318') },
        { ...line(2, 'WOOD SCREW 2”', 8_000, '7318'), qtyMilli: 2000, unitPricePaise: 4_000 },
      ],
    });
    const two = { ...item('WOOD SCREW 2"', '40', '7318'), quantity: '2', basic_amount: '80' };
    two.cgst = '7.20';
    two.sgst = '7.20';
    const both = erp([two, item('WOOD SCREW 2"', '40', '7318')]);
    both.erpInvoiceAmountPaise = 14_160;
    const r = receiptComparison(inv, both);
    expect(r.comparison.verdict).toBe('cleared');
    expect(
      rowsOf(r)
        .filter((x) => x.label === 'Quantity')
        .map((x) => x.result),
    ).toEqual(['match', 'match']);
    // One ERP line for two invoice lines: one is paired, the other has no counterpart.
    const short = receiptComparison(inv, erp([item('WOOD SCREW 2"', '40', '7318')]));
    expect(
      rowsOf(short)
        .filter((x) => x.label === 'Item')
        .map((x) => x.result),
    ).toEqual(['match', 'unmatched']);
    expectCountsFromRows(short);
  });

  it('an item name not read with certainty is asked, and a leftover ERP item is not called extra', () => {
    const inv = invoice();
    (inv.lines[0] as Line).description = null;
    (inv.lines[0] as Line).unitPricePaise = null;
    const r = receiptComparison(inv, erp());
    expect(r.comparison.verdict).toBe('incomplete');
    expect(r.comparison).toMatchObject({ mismatched: 0, unmatched: 0 });
    expect(r.unread).toContain('lines[1].description');
    expect(rowsOf(r).find((x) => x.erp === 'MIRROR')?.result).toBe('needs_confirmation');
    expectCountsFromRows(r);
  });

  it('a line amount not read is to confirm, never a difference, and never filled from the ERP', () => {
    const inv = invoice();
    for (const i of [1, 2, 3]) (inv.lines[i] as Line).taxablePaise = null;
    const r = receiptComparison(inv, erp());
    expect(r.comparison.verdict).toBe('incomplete');
    expect(r.comparison.mismatched).toBe(0);
    expect(r.unread).toEqual(
      expect.arrayContaining([
        'lines[2].taxablePaise',
        'lines[3].taxablePaise',
        'lines[4].taxablePaise',
      ]),
    );
    expect(inv.lines.map((l) => l.taxablePaise)).toEqual([345_000, null, null, null]);
    expectCountsFromRows(r);
  });

  it('HSN missing on both sides is not compared and does not hold the invoice up', () => {
    const inv = invoice();
    for (const l of inv.lines) l.hsnSac = null;
    const noHsn = erp([
      { ...item('GATTA', '40', '3926'), hsn_sac_code: null },
      { ...item('WOOD SCREW 2"', '40', '7318'), hsn_sac_code: null },
      { ...item('MIRROR', '3450', '7009'), hsn_sac_code: null },
      { ...item('COOLIE', '1250', '9987'), hsn_sac_code: null },
    ]);
    const r = receiptComparison(inv, noHsn);
    expect(r.comparison.verdict).toBe('cleared');
    expect(
      rowsOf(r)
        .filter((x) => x.label === 'HSN/SAC')
        .map((x) => x.result),
    ).toEqual(['not_compared', 'not_compared', 'not_compared', 'not_compared']);
    // The ERP holds an HSN, the invoice's was not read: that one is to confirm.
    const one = receiptComparison(inv, erp());
    expect(one.unread).toContain('lines[1].hsnSac');
  });

  it('the printed order 684 is kept apart from the ERP’s internal reference', () => {
    const r = receiptComparison(invoice(), erp());
    const order = find(r, /Purchase order/, 'Order');
    expect(order).toMatchObject({
      invoice: '684',
      erp: 'ERP internal reference 55012',
      result: 'not_compared',
    });
    // Not compared is not a failed comparison: it is not counted as a difference or to confirm.
    expect(r.comparison.mismatched + r.comparison.needsConfirmation).toBe(0);
  });

  it('several GST rates and an exempt item: the tax is checked per rate', () => {
    const inv = invoice({
      taxablePaise: 478_000,
      // 18% on 3,530.00 = 635.40; the labour line is exempt.
      cgstPaise: 31_770,
      sgstPaise: 31_770,
      roundOffPaise: -40,
      totalPaise: 541_500,
      lines: [
        line(1, 'MIRROR', 345_000, '7009'),
        line(2, 'WOOD SCREW 2”', 4_000, '7318'),
        line(3, 'GATTA', 4_000, '3926'),
        { ...line(4, 'Coolie', 125_000, '9987'), gstRateBp: 0 },
      ],
    });
    const r = receiptComparison(inv, erp());
    expect(find(r, /arithmetic/, 'GST calculated from the rates')?.result).toBe('match');
    expect(find(r, /arithmetic/, 'Lines + tax + round-off = total')?.result).toBe('match');
    // Totals that conflict with the lines are caught, not cleared.
    const off = receiptComparison({ ...inv, totalPaise: 541_600 }, erp());
    expect(find(off, /arithmetic/, 'Lines + tax + round-off = total')?.result).toBe('mismatch');
  });

  it('a round-off or tax printed but not read is asked, never taken as zero', () => {
    // As a scan may read it: the round-off (-0.40) printed but not read with certainty.
    const inv = invoice({ roundOffPaise: null, unclear: ['header.roundOffPaise'] });
    const r = receiptComparison(inv, erp());
    expect(r.comparison).toMatchObject({ verdict: 'incomplete', mismatched: 0 });
    expect(find(r, /arithmetic/, 'Lines + tax + round-off = total')?.result).toBe(
      'needs_confirmation',
    );
    expect(find(r, /Totals/, 'Invoice total')?.result).toBe('needs_confirmation');
    expect(r.unread).toContain('header.roundOffPaise');
    expect(r.totalDeltaPaise).toBeNull();
    // Truly not printed (not listed as unclear): zero, and the total does not add up by 0.40.
    const absent = receiptComparison(invoice({ roundOffPaise: null }), erp());
    expect(find(absent, /arithmetic/, 'Lines + tax + round-off = total')?.result).toBe('mismatch');
    // A tax head printed but not read: the GST check waits for it.
    const tax = receiptComparison(
      invoice({ sgstPaise: null, unclear: ['header.sgstPaise'] }),
      erp(),
    );
    expect(find(tax, /arithmetic/, 'GST calculated from the rates')?.result).toBe(
      'needs_confirmation',
    );
    expect(tax.comparison.verdict).toBe('incomplete');
    expectCountsFromRows(tax);
  });

  it('the same comparison twice gives the same rows, counts and differences (no duplicates)', () => {
    const inv = invoice();
    (inv.lines[3] as Line).taxablePaise = null;
    const a = receiptComparison(inv, erp());
    const b = receiptComparison(inv, erp());
    expect(b).toEqual(a);
    expect(new Set(a.unread).size).toBe(a.unread.length);
    expectCountsFromRows(a);
  });
});

describe('which ERP receipt the invoice is compared with', () => {
  const rec = (grnNo: string, names: string[], vendor = 'SAMPLE ELECTRICAL AND HARDWARE') => {
    const r = erp(names.map((n) => item(n, '40', '3926')));
    r.grnNo = grnNo;
    r.vendorName = vendor;
    return { record: r };
  };

  it('a receipt exported again replaces the earlier export: one receipt, nothing to confirm', () => {
    const picked = pickRecord(
      [rec('871', ['MIRROR']), rec('871', ['MIRROR', 'GATTA'])],
      'Sample Electrical & Hardware',
    );
    expect(picked?.alternatives).toEqual([]);
    expect(picked?.picked.record.lines).toHaveLength(2);
  });

  it('two receipts for one invoice: the one whose lines fit is compared, and it is to confirm', () => {
    const lines = invoice().lines;
    const wrong = rec('870', ['HINGE', 'TOWER BOLT']);
    const right = rec('871', ['MIRROR', 'WOOD SCREW 2"', 'GATTA', 'COOLIE']);
    // The wrong one imported last is not taken just because it is the latest.
    const picked = pickRecord([right, wrong], 'Sample Electrical & Hardware', lines);
    expect(picked?.picked.record.grnNo).toBe('871');
    expect(picked?.alternatives.map((a) => a.record.grnNo)).toEqual(['870']);
    const r = receiptComparison(invoice(), erp(), { otherReceipts: ['870'] });
    expect(find(r, /ERP receipt/, 'Matched ERP record')?.result).toBe('needs_confirmation');
    expect(r.comparison.verdict).toBe('incomplete');
    expect(r.differences).toEqual([
      expect.objectContaining({ label: 'Matched ERP record', confirm: true }),
    ]);
  });

  it('another supplier’s receipt with the same invoice number is never taken', () => {
    const picked = pickRecord(
      [rec('871', ['MIRROR']), rec('990', ['MIRROR'], 'OTHER TRADERS')],
      'Sample Electrical & Hardware',
    );
    expect(picked?.picked.record.grnNo).toBe('871');
    expect(picked?.alternatives).toEqual([]);
  });
});
