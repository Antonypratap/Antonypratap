import { describe, expect, it } from 'vitest';
import {
  normalizeReceipt,
  receiptComparison,
  type InvoiceSide,
  type RawReceiptRecord,
} from '../workflow/erp-receipts';
import { looksLikeLabel, verificationOutcome } from './result';

/**
 * A reported misread, replayed with made-up names and numbers: the supplier name read from the
 * MSME line above it, no item line read, and the SGST read as the supply value (3,982.00) instead of
 * the tax (358.38). The reference record is right. A misreading must never be reported as a proven
 * difference: the verification is REVIEW_REQUIRED, never FAILED.
 */
const misread: InvoiceSide = {
  vendorName: '| MSME No: UDYAM-KR-03-0001234',
  vendorGstin: null,
  invoiceNumber: '21/2026-27',
  invoiceDate: '2026-04-04',
  poNumber: null,
  taxablePaise: null,
  cgstPaise: 35_838,
  sgstPaise: 398_200,
  igstPaise: null,
  roundOffPaise: 24,
  totalPaise: 469_900,
  freightPaise: null,
  lines: [],
};
const item = (name: string, qty: string, rate: string, amount: string) => ({
  item_name: name,
  uom: 'NOS',
  quantity: qty,
  basic_rate: rate,
  basic_amount: amount,
  cgst: (Number(amount) * 0.09).toFixed(2),
  sgst: (Number(amount) * 0.09).toFixed(2),
});
const reference = normalizeReceipt({
  invoice_info: {
    grn_id: '1',
    grn_no: '9002',
    dc_no: '21/2026-27',
    invoice_date: '2026-04-04',
    invoice_amount: '4699',
    vendor_name: 'NEELA TRADING CO.',
  },
  items: [
    item('Calcium chloride 500gm', '10', '284', '2840'),
    item('Calcium sulphate 500gm', '2', '235', '470'),
    item('Magnesium sulphate 500gm', '4', '168', '672'),
  ],
} as unknown as RawReceiptRecord);

describe('a misread invoice is asked about, never failed', () => {
  const c = receiptComparison(misread, reference);
  const out = verificationOutcome(c.rows, misread, c.totalDeltaPaise);
  const check = (field: string) => out.checks.find((x) => x.field === field);

  it('is REVIEW_REQUIRED with nothing failed', () => {
    expect(out.failed_fields).toEqual([]);
    expect(out.status).toBe('REVIEW_REQUIRED');
  });

  it('never calculates a goods value of zero when no line was read', () => {
    const goods = out.checks.find((x) => x.label === 'Goods value (sum of lines)');
    expect(goods?.invoice_value).toBeNull();
    expect(goods?.result).toBe('unverified');
  });

  it('a supplier name that reads like a registration line is unverified, with the reason', () => {
    expect(check('header.vendorName')?.result).toBe('unverified');
    expect(check('header.vendorName')?.reason).toMatch(/registration or contact line/);
  });

  it("a tax that breaks the invoice's own arithmetic is unverified", () => {
    expect(check('header.sgstPaise')?.result).toBe('unverified');
    expect(check('header.sgstPaise')?.reason).toMatch(/do not add up/);
  });

  it('a well-read invoice that really differs still fails', () => {
    const right: InvoiceSide = {
      ...misread,
      vendorName: 'OTHER SUPPLIERS',
      sgstPaise: 35_838,
      lines: [],
    };
    const r = receiptComparison(right, reference);
    const o = verificationOutcome(r.rows, right, r.totalDeltaPaise);
    expect(o.status).toBe('FAILED');
    expect(o.failed_fields.map((f) => f.field)).toContain('header.vendorName');
  });
});

describe('label-like supplier names', () => {
  it.each([
    '| MSME No: UDYAM-KR-03-0001234',
    'MSME No: UDYAM-KR-03-0001234',
    'PAN No: AAKCE3344D',
    'GSTIN: 29AAKCE3344D1ZP',
    'Phone: 9845012345',
  ])('%s is a label, not a name', (n) => expect(looksLikeLabel(n)).toBe(true));
  it.each(['NEELA TRADING CO.', 'Sample Electrical & Hardware', 'A1 Steels (Pvt) Ltd', null])(
    '%s is a name',
    (n) => expect(looksLikeLabel(n)).toBe(false),
  );
});
