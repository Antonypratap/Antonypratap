import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readCsv, writeCsv } from './csv';
import { readXlsx, writeXlsx, SpreadsheetError } from './xlsx';
import { readZip, writeZip, ZipError } from './zip';

const FIXTURE = new URL('../test/fixtures/excel-style.xlsx', import.meta.url);

describe('zip', () => {
  it('round-trips stored entries deterministically', () => {
    const files = [
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'dir/b.xml', data: Buffer.from('<x/>') },
    ];
    const zip = writeZip(files);
    expect(writeZip(files).equals(zip)).toBe(true);
    const r = readZip(zip);
    expect(r.names).toEqual(['a.txt', 'dir/b.xml']);
    expect(r.read('a.txt')?.toString()).toBe('hello');
    expect(r.read('missing')).toBeNull();
  });

  it('refuses entries that expand beyond what they declare (zip bomb guard)', () => {
    const zip = writeZip([{ name: 'x', data: Buffer.alloc(10) }]);
    // Replace the stored entry with a deflated one that inflates to far more than 10 bytes.
    const bomb = deflateRawSync(Buffer.alloc(1_000_000));
    const local = Buffer.from(zip.subarray(0, 30 + 1));
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(bomb.length, 18);
    const cdStart = 30 + 1 + 10;
    const central = Buffer.from(zip.subarray(cdStart, cdStart + 46 + 1));
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(bomb.length, 20);
    const end = Buffer.from(zip.subarray(zip.length - 22));
    end.writeUInt32LE(30 + 1 + bomb.length, 16);
    const forged = Buffer.concat([local, bomb, central, end]);
    expect(() => readZip(forged).read('x')).toThrow();
  });

  it('refuses non-zip data and archives over the limits', () => {
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(ZipError);
    const many = writeZip(
      Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') })),
    );
    expect(() => readZip(many, { maxEntries: 3, maxEntryBytes: 100, maxTotalBytes: 100 })).toThrow(
      /too many/,
    );
  });
});

describe('xlsx', () => {
  it('reads back what it writes: text, numbers and exact money', () => {
    const bytes = writeXlsx([
      {
        name: 'Data',
        widths: [10, 10, 10],
        header: true,
        rows: [
          ['a', 'b', 'c'],
          ['x & <y>', 42, { money: '113870.00' }],
        ],
      },
    ]);
    const wb = readXlsx(bytes);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Data']);
    const row = wb.sheets[0]?.rows[1];
    expect(row?.rowNumber).toBe(2);
    expect(row?.cells.map((c) => [c.text, c.kind])).toEqual([
      ['x & <y>', 'string'],
      ['42', 'number'],
      ['113870.00', 'number'],
    ]);
  });

  it('reads a workbook written by another program: shared strings, dates, percentages, booleans', () => {
    const wb = readXlsx(readFileSync(FIXTURE));
    expect(wb.sheets.map((s) => s.name)).toEqual([
      'Notes',
      'Suppliers',
      'Items',
      'Purchase orders',
      'Purchase order lines',
      'Goods receipts',
      'Goods receipt lines',
    ]);
    const items = wb.sheets.find((s) => s.name === 'Items');
    expect(items?.rows[1]?.cells[4]).toMatchObject({
      text: '0.12',
      kind: 'number',
      format: 'percent',
    });
    const po = wb.sheets.find((s) => s.name === 'Purchase orders');
    expect(po?.rows[1]?.cells[2]).toMatchObject({ kind: 'number', format: 'date' });
    const suppliers = wb.sheets.find((s) => s.name === 'Suppliers');
    expect(suppliers?.rows[2]?.cells[6]).toMatchObject({ text: 'TRUE', kind: 'boolean' });
  });

  it('never evaluates a formula: one with no stored value reads as empty, marked as a formula', () => {
    const wb = readXlsx(readFileSync(FIXTURE));
    const lines = wb.sheets.find((s) => s.name === 'Goods receipt lines');
    expect(lines?.rows[1]?.cells[4]).toMatchObject({ kind: 'empty', formula: true });
  });

  it('refuses files that are not workbooks', () => {
    expect(() => readXlsx(Buffer.from('hello'))).toThrow(SpreadsheetError);
    expect(() => readXlsx(writeZip([{ name: 'x.txt', data: Buffer.from('x') }]))).toThrow(
      /not an Excel workbook/,
    );
  });
});

describe('csv', () => {
  it('parses quotes, commas, new lines and a byte-order mark', () => {
    const rows = readCsv(Buffer.from('﻿a,b\r\n"x, y","say ""hi"""\n\n"multi\nline",3\n'), 't.csv');
    expect(rows.map((r) => [r.rowNumber, r.cells.map((c) => c.text)])).toEqual([
      [1, ['a', 'b']],
      [2, ['x, y', 'say "hi"']],
      [4, ['multi\nline', '3']],
    ]);
  });

  it('guards exported cells against formula injection', () => {
    const csv = writeCsv([['=HYPERLINK("x")', '+1', '-2', '@a', 'safe', 3]]).toString('utf8');
    expect(csv).toContain(`"'=HYPERLINK(""x"")",'+1,'-2,'@a,safe,3`);
  });
});
