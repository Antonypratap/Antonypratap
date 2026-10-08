import { describe, expect, it } from 'vitest';
import { SOURCE_FIELDS, SOURCE_FIELD_LABELS, REQUIRED_SOURCE_FIELDS } from '@veyra/shared';
import { collectReceipts, REGISTER_FIELDS, REQUIRED_FIELDS } from '../challenge/register';
import { readCsv } from '../spreadsheet/csv';
import { normalizeReceipt, ReceiptFileSchema } from '../workflow/erp-receipts';
import {
  applyMapping,
  cleanMapping,
  detectHeaderRow,
  headerSignature,
  headerTexts,
  proposeMapping,
  sampleValues,
} from './mapping';

/** A register as people keep it in Excel or Google Sheets. Made-up data only. */
const csv = (text: string) => readCsv(new TextEncoder().encode(text), 'register.csv');
const records = (raw: unknown) => ReceiptFileSchema.parse(raw).data.map(normalizeReceipt);

describe('column mapping', () => {
  it('the fields the screen offers are exactly the register fields', () => {
    expect([...SOURCE_FIELDS].sort()).toEqual([...REGISTER_FIELDS].sort());
    expect([...REQUIRED_SOURCE_FIELDS]).toEqual([...REQUIRED_FIELDS]);
    expect(Object.keys(SOURCE_FIELD_LABELS).sort()).toEqual([...REGISTER_FIELDS].sort());
  });

  it('proposes the known column names exactly', () => {
    const header = ['Invoice No', 'Supplier', 'Invoice Date', 'Item', 'Qty', 'Rate', 'Amount'];
    expect(proposeMapping(header)).toEqual({
      invoiceNo: 0,
      supplier: 1,
      date: 2,
      item: 3,
      qty: 4,
      rate: 5,
      amount: 6,
    });
  });

  it('proposes columns named the way businesses name them, one column per field', () => {
    const header = [
      'Bill #',
      'Vendor A/c',
      'Vendor GSTIN',
      'Bill Dt.',
      'Material',
      'Qnty',
      'Price',
      'Taxable Value',
      'CGST Amt',
      'SGST Amt',
      'Bill Total',
      'GRN Ref',
    ];
    const m = proposeMapping(header);
    expect(m).toMatchObject({
      invoiceNo: 0,
      supplier: 1,
      date: 3,
      item: 4,
      qty: 5,
      rate: 6,
      amount: 7,
      cgst: 8,
      sgst: 9,
      total: 10,
      reference: 11,
    });
    // The supplier's GSTIN is not taken for the supplier, and no column is used twice.
    expect(Object.values(m)).not.toContain(2);
    expect(new Set(Object.values(m)).size).toBe(Object.values(m).length);
  });

  it('leaves a field unmapped rather than forcing a column', () => {
    expect(proposeMapping(['Remarks', 'Approved by'])).toEqual({});
  });

  it('finds the header under title rows', () => {
    const rows = csv(
      'Purchase register,,,\nApril 2026,,,\nBill No,Party Name,Item,Qty\nB-1,Example Traders,Bolt,10\n',
    );
    const at = detectHeaderRow(rows);
    expect(at).toBe(2);
    expect(headerTexts(rows[at])).toEqual(['Bill No', 'Party Name', 'Item', 'Qty']);
  });

  it('reads rows through a confirmed mapping, with their row numbers in the sheet', () => {
    const rows = csv(
      'Register,,,,\nInv,Vendor,Product,Units,Unit price\nB-1,Example Traders,Bolt,10,4.50\nB-1,Example Traders,Nut,20,about 1\n,Example Traders,Washer,5,1\n',
    );
    const header = headerTexts(rows[1]);
    const mapping = cleanMapping(
      { invoiceNo: 0, supplier: 1, item: 2, qty: 3, rate: 4, total: 99, unknown: 1 },
      header.length,
    );
    // A column outside the sheet, or a field Veyrafy doesn't know, is dropped.
    expect(mapping).toEqual({ invoiceNo: 0, supplier: 1, item: 2, qty: 3, rate: 4 });
    const read = applyMapping(rows, 1, mapping);
    const result = collectReceipts(read.rows, read.rowNumbers);
    expect(result).toMatchObject({ invoices: 1, lines: 2, tooMany: false });
    // Problems are reported by the row number the person sees in their sheet.
    expect(result.errors).toEqual([{ row: 5, field: 'invoiceNo', problem: 'missing' }]);
    expect(result.warnings).toEqual([{ row: 4, field: 'rate', problem: 'not_a_number' }]);
    const [rec] = records(result.receipts);
    expect(rec?.lines.map((l) => [l.qtyMilli, l.ratePaise])).toEqual([
      [10_000, 450],
      [20_000, null],
    ]);
  });

  it('shows a few example values per column', () => {
    const rows = csv('Item,Qty\nBolt,1\n,2\nNut,3\nWasher,4\n');
    expect(sampleValues(rows, 0, 0)).toEqual(['Bolt', 'Nut', 'Washer']);
  });

  it('notices when the columns change, but not case or spacing', () => {
    const a = headerSignature(['Invoice No', 'Supplier', 'Item']);
    expect(headerSignature(['invoice no ', 'SUPPLIER', 'Item'])).toBe(a);
    expect(headerSignature(['Invoice No', 'Vendor', 'Item'])).not.toBe(a);
    expect(headerSignature(['Supplier', 'Invoice No', 'Item'])).not.toBe(a);
  });
});
