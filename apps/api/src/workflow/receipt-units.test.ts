import { describe, expect, it } from 'vitest';
import { verificationOutcome } from '../verify/result';
import {
  normalizeReceipt,
  receiptComparison,
  ReceiptFileSchema,
  unitsDiffer,
  type InvoiceSide,
} from './erp-receipts';

/**
 * A supplier that sells 500 g packs to a buyer whose ERP records kilograms, the ERP's own item
 * names, an "ASSESSABLE" entry repeating each line's value, and the invoice amount recorded before
 * the round-off. Every value agrees; nothing may be reported as a difference. Made-up names.
 */
const L = (lineNo: number, description: string, q: number, rate: number, amount: number) => ({
  lineNo,
  description,
  hsnSac: null,
  uom: 'NOS',
  qtyMilli: q * 1000,
  unitPricePaise: rate * 100,
  taxablePaise: amount * 100,
  gstRateBp: 1800,
});
const invoice: InvoiceSide = {
  vendorName: 'NEELA TRADING CO.',
  vendorGstin: '29AAKCE3344D1ZP',
  invoiceNumber: '21/2026-27',
  invoiceDate: '2026-04-04',
  poNumber: '07',
  taxablePaise: null,
  cgstPaise: 35_838,
  sgstPaise: 35_838,
  igstPaise: null,
  roundOffPaise: 24,
  totalPaise: 469_900,
  freightPaise: null,
  lines: [
    L(1, '5521-Potassium nitrate LR 500gm', 10, 284, 2840),
    L(2, '7713-SODIUM BICARBONATE EXTRA PURE 500gm', 2, 235, 470),
    L(3, '9901-ZINC SULPHATE HEPTAHYDRATE LR 500gm', 4, 168, 672),
  ],
};
const item = (name: string, q: string, rate: string, amount: number) => ({
  item_name: name,
  hsn_sac_code: null,
  uom: 'KGS',
  quantity: q,
  basic_rate: rate,
  basic_amount: amount,
  discount: 0,
  cgst: +(amount * 0.09).toFixed(2),
  sgst: +(amount * 0.09).toFixed(2),
  igst: 0,
  freight: 0,
  other_charges: [{ code: 'ASSESSABLE', value: amount }],
});
// One record, as the verification API takes it (not wrapped in the export's `data`).
/** The one record in a parsed reference (fails the test when there is none). */
const only = (v: unknown) => {
  const [r] = ReceiptFileSchema.parse(v).data;
  if (!r) throw new Error('no record');
  return normalizeReceipt(r);
};
const single = {
  grn_id: 77,
  invoice_info: {
    grn_id: 77,
    grn_no: 13,
    po_id: 4400,
    po_no: 7,
    dc_no: '21/2026-27',
    grn_date: '04/04/2026',
    invoice_date: '04/04/2026',
    invoice_amount: 4698.76,
    vendor_name: 'Neela Trading Co.',
    vendor_code: 'SCM0000099',
  },
  items: [
    item('Salt KNO3 Potassium Nitrate', '5', '568', 2840),
    item('Sodium Bicarbonate NaHCO3', '1', '470', 470),
    item('Zinc Sulfate (ZnSO4)', '2', '336', 672),
  ],
};

describe('ERP record in other units, with its own item names', () => {
  const erp = only(single);
  const c = receiptComparison(invoice, erp);
  const row = (section: RegExp, label: string) =>
    c.rows.find((r) => section.test(r.section) && r.label === label);

  it('reads a single record, a list, or the export', () => {
    expect(ReceiptFileSchema.parse([single]).data).toHaveLength(1);
    expect(ReceiptFileSchema.parse({ data: [single] }).data).toHaveLength(1);
    expect(ReceiptFileSchema.safeParse({ something: 'else' }).success).toBe(false);
  });

  it('an "ASSESSABLE" value is the line value again, never a charge added to the total', () => {
    expect(erp.lines.every((l) => l.other.length === 0)).toBe(true);
    expect(row(/Totals/, 'Invoice total')?.result).toBe('match');
    expect(c.rows.some((r) => /ASSESSABLE/.test(r.label))).toBe(false);
  });

  it('the amount the ERP recorded before the round-off matches', () => {
    expect(row(/Totals/, 'Invoice amount recorded in the ERP')?.result).toBe('match');
  });

  it('packs and kilograms: asked once per line, never a difference; amounts still compared', () => {
    for (const n of [1, 2, 3]) {
      expect(row(new RegExp(`^Line ${n} `), 'Quantity')?.result).toBe('needs_confirmation');
      expect(row(new RegExp(`^Line ${n} `), 'Quantity')?.note).toMatch(/different units/);
      expect(row(new RegExp(`^Line ${n} `), 'Rate')?.result).toBe('not_compared');
      expect(row(new RegExp(`^Line ${n} `), 'Amount')?.result).toBe('match');
    }
  });

  it("the supplier's item wording and the ERP's name: confirmed, not failed", () => {
    for (const n of [1, 2, 3])
      expect(row(new RegExp(`^Line ${n} `), 'Item')?.result).toBe('needs_confirmation');
  });

  it('nothing differs: REVIEW_REQUIRED (to confirm), never FAILED', () => {
    expect(c.comparison.mismatched + c.comparison.unmatched).toBe(0);
    const o = verificationOutcome(c.rows, invoice, c.totalDeltaPaise);
    expect(o.status).toBe('REVIEW_REQUIRED');
    expect(o.failed_fields).toEqual([]);
  });

  it('a real difference in the same units still fails', () => {
    const short = only({
      ...single,
      items: [
        { ...item('Salt KNO3 Potassium Nitrate', '8', '284', 2272), uom: 'NOS' },
        single.items[1],
        single.items[2],
      ],
    });
    const r = receiptComparison(invoice, short);
    expect(r.rows.find((x) => /^Line 1 /.test(x.section) && x.label === 'Quantity')?.result).toBe(
      'mismatch',
    );
    expect(verificationOutcome(r.rows, invoice, r.totalDeltaPaise).status).toBe('FAILED');
  });
});

describe('units', () => {
  it.each([
    ['NOS', 'PCS'],
    ['Nos', 'each'],
    ['KGS', 'kg'],
    ['Kilogram', 'KGS'],
    ['LTR', 'litres'],
    [null, 'KGS'],
  ])('%s and %s are the same unit (or one is not known)', (a, b) =>
    expect(unitsDiffer(a, b)).toBe(false),
  );
  it.each([
    ['NOS', 'KGS'],
    ['GMS', 'KGS'],
    ['BOX', 'NOS'],
  ])('%s and %s differ', (a, b) => expect(unitsDiffer(a, b)).toBe(true));
});

describe('a round-off that could not be read', () => {
  const erp = only(single);
  const unread: InvoiceSide = {
    ...invoice,
    roundOffPaise: null,
    igstPaise: null,
    unclear: ['header.roundOffPaise', 'header.igstPaise'],
  };

  it('the total is compared rounded to the rupee; an unread IGST does not matter beside CGST + SGST', () => {
    const c = receiptComparison(unread, erp);
    const row = (label: string) => c.rows.find((r) => r.label === label);
    expect(row('Invoice total')?.result).toBe('match');
    expect(row('Lines + tax + round-off = total')?.result).toBe('match');
    expect(row('GST calculated from the rates')?.result).toBe('match');
  });

  it('a total that is not the rest rounded to the rupee is still asked', () => {
    const c = receiptComparison({ ...unread, totalPaise: 470_900 }, erp);
    expect(c.rows.find((r) => r.label === 'Invoice total')?.result).toBe('needs_confirmation');
  });
});
