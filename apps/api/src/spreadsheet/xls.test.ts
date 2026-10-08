import { describe, expect, it } from 'vitest';
import { collectReceipts } from '../challenge/register';
import { applyMapping, detectHeaderRow, headerTexts, proposeMapping } from '../sources/mapping';
import {
  boolErr,
  compoundFile,
  format,
  formulaNumber,
  formulaString,
  label,
  labelSst,
  mulrk,
  number,
  rec,
  rk,
  rkInt,
  sst,
  T,
  u16,
  workbookStream,
  xf,
} from '../test/xls-writer';
import { readSpreadsheet, spreadsheetKind } from './read';
import { isCompoundFile, readXls } from './xls';
import { MAX_COLUMNS, SpreadsheetError, writeXlsx } from './xlsx';

/**
 * Legacy Excel (.xls) files, built byte by byte by the test writer with made-up data. XF
 * styles: 0 general, 1 a built-in date, 2 a custom date ("dd/mm/yyyy"), 3 a built-in percent.
 */
const STYLES = [xf(0), xf(14), xf(164), xf(9)];
const GLOBALS = (strings: string[], extra: Uint8Array[] = []) => [
  format(164, 'dd/mm/yyyy'),
  ...STYLES,
  ...extra,
  sst(strings, { string: 1, afterChars: 3 }),
];

function sample(regular = true) {
  const strings = ['Invoice No', 'Supplier ₹ खाता', 'Item', 'Bolt'];
  const stream = workbookStream(GLOBALS(strings), [
    {
      name: 'Register',
      records: [
        labelSst(0, 0, 0),
        labelSst(0, 1, 1),
        labelSst(0, 2, 2),
        label(0, 3, 'Qty'),
        labelSst(1, 2, 3),
        number(1, 3, 12.5),
        rk(1, 4, rkInt(46000), 1),
        rk(1, 5, rkInt(1850, true)),
        mulrk(2, 0, [
          { xf: 2, rk: rkInt(46001) },
          { xf: 3, rk: rkInt(18, true) },
        ]),
        boolErr(2, 2, 1, false),
        boolErr(2, 3, 0x07, true),
        formulaNumber(3, 0, 99.75),
        ...formulaString(3, 1, 'from a formula'),
        number(3, MAX_COLUMNS + 2, 1),
      ],
    },
    { name: 'Notes', records: [label(4, 0, 'second sheet')] },
  ]);
  return compoundFile(stream, { regular });
}

describe('legacy Excel (.xls)', () => {
  it('reads strings, numbers, dates, percentages, booleans, errors and formula results', () => {
    const wb = readXls(sample());
    expect(wb.date1904).toBe(false);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Register', 'Notes']);
    const [r0, r1, r2, r3] = wb.sheets[0]?.rows ?? [];
    expect(r0?.rowNumber).toBe(1);
    // A shared string split across records, in UTF-16, is read whole.
    expect(r0?.cells.map((c) => c.text)).toEqual(['Invoice No', 'Supplier ₹ खाता', 'Item', 'Qty']);
    expect(r1?.cells.slice(2)).toEqual([
      { text: 'Bolt', kind: 'string', format: null, formula: false },
      { text: '12.5', kind: 'number', format: null, formula: false },
      { text: '46000', kind: 'number', format: 'date', formula: false },
      { text: '18.5', kind: 'number', format: null, formula: false },
    ]);
    expect(r2?.cells.map((c) => [c.text, c.kind, c.format])).toEqual([
      ['46001', 'number', 'date'],
      ['0.18', 'number', 'percent'],
      ['TRUE', 'boolean', null],
      ['#DIV/0!', 'error', null],
    ]);
    // The value a formula last showed; it is never calculated.
    expect(r3?.cells.slice(0, 2)).toEqual([
      { text: '99.75', kind: 'number', format: null, formula: true },
      { text: 'from a formula', kind: 'string', format: null, formula: true },
    ]);
    // Columns past the limit are dropped, as in .xlsx.
    expect(r3?.cells.length).toBe(2);
    // Cells before the first one in a row are empty; the row keeps its number.
    expect(wb.sheets[1]?.rows).toEqual([
      {
        rowNumber: 5,
        cells: [{ text: 'second sheet', kind: 'string', format: null, formula: false }],
      },
    ]);
  });

  it('reads a small workbook kept in the mini stream the same way', () => {
    expect(readXls(sample(false))).toEqual(readXls(sample(true)));
  });

  it('knows the 1904 date system', () => {
    const stream = workbookStream(
      [...STYLES, rec(T.DATEMODE, u16(1))],
      [{ name: 'S', records: [rk(0, 0, rkInt(100), 1)] }],
    );
    expect(readXls(compoundFile(stream)).date1904).toBe(true);
  });

  it('is told apart from .xlsx and CSV by its first bytes', () => {
    const xls = sample();
    expect(isCompoundFile(xls)).toBe(true);
    expect(spreadsheetKind(xls)).toBe('xls');
    expect(
      spreadsheetKind(writeXlsx([{ name: 'S', widths: [10], rows: [['a']], header: false }])),
    ).toBe('xlsx');
    expect(spreadsheetKind(new TextEncoder().encode('a,b\n1,2\n'))).toBe('csv');
    expect(readSpreadsheet(xls, 'register.xls').sheets[0]?.name).toBe('Register');
  });

  it('refuses password-protected and pre-1997 workbooks, with what to do', () => {
    const locked = workbookStream(
      [rec(T.FILEPASS, new Uint8Array(6)), ...STYLES],
      [{ name: 'S', records: [] }],
    );
    expect(() => readXls(compoundFile(locked))).toThrow(/password-protected/);
    const old = workbookStream(STYLES, [{ name: 'S', records: [] }], 0x0500);
    expect(() => readXls(compoundFile(old))).toThrow(/older than Excel 97/);
    const book = compoundFile(workbookStream(STYLES, [{ name: 'S', records: [] }]), {
      name: 'Book',
    });
    expect(() => readXls(book)).toThrow(/older than Excel 97/);
  });

  it('refuses broken files instead of looping or reading past them', () => {
    // A sector chain that loops back on itself.
    const loop = compoundFile(new Uint8Array(5000), {
      corrupt: (fat) => {
        fat[3] = 2;
      },
    });
    expect(() => readXls(loop)).toThrow(SpreadsheetError);
    expect(() => readXls(loop)).toThrow(/loop|broken|not a readable/);
    // A file cut short.
    const whole = sample();
    expect(() => readXls(whole.subarray(0, 1100))).toThrow(SpreadsheetError);
    // Not a compound file at all.
    expect(() => readXls(new Uint8Array(600))).toThrow(/not a readable \.xls/);
    expect(() => readSpreadsheet(Uint8Array.of(0, 1, 2), 'x.bin')).toThrow(
      /Upload an Excel workbook/,
    );
  });

  it('a register saved as .xls is mapped and becomes records to check against', () => {
    const strings = [
      'Purchase register',
      'Bill No',
      'Vendor A/c',
      'Material',
      'Qnty',
      'Price',
      'Bill Dt',
    ];
    const stream = workbookStream(GLOBALS([strings[0] ?? '', ...strings.slice(1)]), [
      {
        name: 'Purchases',
        records: [
          labelSst(0, 0, 0),
          ...[1, 2, 3, 4, 5, 6].map((i) => labelSst(2, i - 1, i)),
          label(3, 0, 'B-77'),
          label(3, 1, 'Example Traders'),
          label(3, 2, 'Hex bolt M8'),
          rk(3, 3, rkInt(200)),
          rk(3, 4, rkInt(750, true)),
          rk(3, 5, rkInt(46000), 2),
        ],
      },
    ]);
    const rows = readXls(compoundFile(stream)).sheets[0]?.rows ?? [];
    const at = detectHeaderRow(rows);
    const header = headerTexts(rows[at]);
    expect(header).toEqual(strings.slice(1));
    const mapping = proposeMapping(header);
    expect(mapping).toMatchObject({ invoiceNo: 0, supplier: 1, item: 2, qty: 3, rate: 4, date: 5 });
    const read = applyMapping(rows, at, mapping);
    const result = collectReceipts(read.rows, read.rowNumbers);
    expect(result).toMatchObject({ invoices: 1, lines: 1, errors: [], warnings: [] });
    expect(read.rows[0]).toMatchObject({
      invoiceNo: 'B-77',
      qty: '200',
      rate: '7.5',
      date: '2025-12-09',
    });
  });
});
