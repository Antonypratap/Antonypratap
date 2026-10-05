import { describe, expect, it } from 'vitest';
import { readCsv } from '../spreadsheet/csv';
import { normalizeReceipt, ReceiptFileSchema } from '../workflow/erp-receipts';
import {
  looksLikeRegister,
  REGISTER_TEMPLATE,
  registerRowsFromJson,
  registerRowsFromSheet,
  registerToReceipts,
} from './register';

/**
 * A business's own record of its invoices, as its system exports it: an Excel or CSV register,
 * or JSON, read into the record each invoice is compared with. Made-up data only.
 */
const csv = (text: string) => readCsv(new TextEncoder().encode(text), 'register.csv');
const records = (raw: unknown) => ReceiptFileSchema.parse(raw).data.map(normalizeReceipt);

describe('invoice register', () => {
  it('reads a register with the names systems use, one record per invoice', () => {
    const rows = csv(
      [
        'Bill No,Party Name,Bill Date,Name of Item,HSN/SAC,Billed Qty,Per,Rate,Taxable Value,Central Tax,State Tax,Invoice Total',
        'INV-7,Example Traders,12-Sep-2026,Steel bracket,7326,100,NOS,"₹ 45.00","4,500.00",405.00,405.00,"6,608.00"',
        'INV-7,Example Traders,12-Sep-2026,Hex bolt M8,7318,200,NOS,7.50,"1,500.00",135.00,135.00,"6,608.00"',
        'INV-9,Other Supplies,13/09/2026,Gloves,4015,10,PAIR,80,800.00,,,"944.00"',
      ].join('\n'),
    );
    expect(looksLikeRegister(rows[0]?.cells.map((c) => c.text) ?? [])).toBe(true);
    const [a, b] = records(registerToReceipts(registerRowsFromSheet(rows), 'register.csv'));
    expect(a).toMatchObject({
      invoiceNo: 'INV-7',
      vendorName: 'Example Traders',
      erpInvoiceDate: '2026-09-12',
      erpInvoiceAmountPaise: 660_800,
    });
    expect(a?.lines).toEqual([
      expect.objectContaining({
        name: 'Steel bracket',
        hsn: '7326',
        qtyMilli: 100_000,
        ratePaise: 4_500,
        amountPaise: 450_000,
        cgstPaise: 40_500,
        sgstPaise: 40_500,
      }),
      expect.objectContaining({ name: 'Hex bolt M8', qtyMilli: 200_000, amountPaise: 150_000 }),
    ]);
    expect(b).toMatchObject({ invoiceNo: 'INV-9', erpInvoiceDate: '2026-09-13' });
  });

  it('reads JSON: flat lines, or invoices with their items', () => {
    const flat = registerRowsFromJson([
      { invoice_no: 'A1', vendor: 'Example Traders', item: 'Bolt', qty: 2, rate: 5, amount: 10 },
    ]);
    expect(records(registerToReceipts(flat ?? [], 'x.json'))[0]).toMatchObject({
      invoiceNo: 'A1',
      lines: [expect.objectContaining({ qtyMilli: 2000, ratePaise: 500, amountPaise: 1000 })],
    });
    const nested = registerRowsFromJson({
      invoices: [
        {
          invoiceNumber: 'B2',
          supplierName: 'Example Traders',
          invoiceDate: '2026-09-01',
          invoiceTotal: '118.00',
          items: [{ description: 'Washer', quantity: '10', unitPrice: '10.00', amount: '100.00' }],
        },
      ],
    });
    expect(records(registerToReceipts(nested ?? [], 'x.json'))[0]).toMatchObject({
      invoiceNo: 'B2',
      erpInvoiceAmountPaise: 11_800,
      lines: [expect.objectContaining({ name: 'Washer', amountPaise: 10_000 })],
    });
    // Not a register: nothing is guessed.
    expect(registerRowsFromJson({ hello: 'world' })).toBeNull();
  });

  it('never guesses: a row without its invoice number, supplier or item is refused', () => {
    const rows = csv(
      'Invoice No,Supplier,Item,Qty\nINV-1,Example Traders,Bolt,1\n,Example Traders,Nut,2\n',
    );
    expect(() => registerToReceipts(registerRowsFromSheet(rows), 'r.csv')).toThrow(
      /row 3 has no invoice number, supplier or item/,
    );
    // A value that is not a plain number stays empty (shown as not held), never estimated.
    const odd = csv('Invoice No,Supplier,Item,Qty,Rate\nINV-1,Example Traders,Bolt,about 5,n/a\n');
    expect(
      records(registerToReceipts(registerRowsFromSheet(odd), 'r.csv'))[0]?.lines[0],
    ).toMatchObject({ qtyMilli: null, ratePaise: null });
    // A sheet of other columns is not taken for a register.
    expect(looksLikeRegister(['Vendor Code', 'Vendor Name', 'GSTIN'])).toBe(false);
  });

  it('the template is a register itself', () => {
    expect(looksLikeRegister([...REGISTER_TEMPLATE.header])).toBe(true);
  });
});
