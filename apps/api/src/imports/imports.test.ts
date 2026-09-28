import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderScenario, scenarioById } from '@veyra/extractor';
import type { ApiAuditEntry, ApiImport, ApiInvoiceDetail, ApiQuestion } from '@veyra/shared';
import type { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';
import { readCsv } from '../spreadsheet/csv';
import { readXlsx, writeXlsx, type OutCell } from '../spreadsheet/xlsx';
import { dataSheet } from './templates';
import type { TableKey } from './spec';
import { createTestApp } from '../test/app';

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;
const FIXTURES = new URL('../../../../fixtures/imports/', import.meta.url);
const fixture = (name: string) => ({
  filename: name,
  bytes: readFileSync(new URL(name, FIXTURES)),
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-import-'));
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
  });
  // Start from an empty business: only the company exists.
  await app.server.inject({ method: 'POST', url: '/api/v1/dev/reset', payload: { erp: 'empty' } });
  app.runner.stop();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function multipart(files: { filename: string; bytes: Uint8Array }[]) {
  const boundary = '----veyra-import-test';
  const parts = files.flatMap((f) => [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(f.bytes),
    Buffer.from('\r\n'),
  ]);
  return {
    payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const workbook = (sheets: Partial<Record<TableKey, OutCell[][]>>, filename = 'upload.xlsx') => ({
  filename,
  bytes: writeXlsx(Object.entries(sheets).map(([k, rows]) => dataSheet(k as TableKey, rows))),
});

async function check(...files: { filename: string; bytes: Uint8Array }[]): Promise<ApiImport> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/v1/imports',
    ...multipart(files),
  });
  expect(res.statusCode).toBe(201);
  return res.json<ApiImport>();
}
async function confirm(id: string) {
  return app.server.inject({ method: 'POST', url: `/api/v1/imports/${id}/confirm` });
}
const get = async <T>(url: string): Promise<T> =>
  (await app.server.inject({ method: 'GET', url })).json<T>();
const erpCounts = async () => ({
  vendors: (await app.veyra.erp.listVendors()).length,
  items: (await app.veyra.erp.listItems()).length,
  pos: (await app.veyra.erp.listPurchaseOrders()).length,
  grns: (await app.veyra.erp.listGrns()).length,
});
const EMPTY = { vendors: 0, items: 0, pos: 0, grns: 0 };

const NANDI = [
  'SUP-01',
  'Nandi Stationers Pvt Ltd',
  '29AADCN9753P1ZH',
  'AADCN9753P',
  'Bengaluru',
  'Karnataka',
  'yes',
];
const PAPER = ['PAPER-A4', 'A4 Copier Paper 75 GSM', '4802', 'REAM', '12'];

describe('vendors', () => {
  it('a valid vendor file previews, then imports through the ERP connector', async () => {
    const preview = await check(workbook({ vendors: [NANDI] }, 'Vendors.xlsx'));
    expect(preview).toMatchObject({ status: 'ready', canConfirm: true, errorCount: 0 });
    expect(preview.tables).toEqual([
      expect.objectContaining({ label: 'Vendors', rows: 1, ready: 1, existing: 0, errors: 0 }),
    ]);
    expect(await erpCounts()).toEqual(EMPTY); // nothing yet
    const done = (await confirm(preview.id)).json<ApiImport>();
    expect(done).toMatchObject({
      status: 'imported',
      result: { created: { vendors: 1 }, skipped: { vendors: 0 } },
    });
    expect(await app.veyra.erp.listVendors()).toEqual([
      expect.objectContaining({
        code: 'SUP-01',
        origin: 'imported',
        sourceImportId: preview.id,
        stateCode: '29',
        pan: 'AADCN9753P',
      }),
    ]);
  });

  it('an invalid vendor file lists every problem by row, and imports nothing', async () => {
    const preview = await check(
      workbook({
        vendors: [
          NANDI,
          ['', 'No Code Traders', '29AAKCE3344D1ZP', '', 'Bengaluru', '', 'yes'],
          ['SUP-03', 'Meridian Fasteners', '29AAGCM4455J1Z5', '', 'Whitefield', '', 'yes'],
          [
            'SUP-04',
            'Wrong PAN',
            '29AAKCE3344D1ZP',
            'AAAAA0000A',
            'Bengaluru',
            'Tamil Nadu',
            'maybe',
          ],
          ['SUP-01', 'Duplicate code', '27AAACA4321M1ZT', '', 'Pune', '', 'yes'],
        ],
      }),
    );
    expect(preview).toMatchObject({ status: 'invalid', canConfirm: false });
    expect(preview.errors.map((e) => `${e.row}: ${e.message}`)).toEqual([
      '3: Vendor code is missing.',
      '4: GSTIN 29AAGCM4455J1Z5 is not valid: the check digit does not match.',
      '5: Active must be yes or no.',
      '6: Vendor code SUP-01 also appears on row 2.',
      '5: GSTIN 29AAKCE3344D1ZP also appears on row 3.',
      '5: PAN AAAAA0000A does not match the GSTIN (it should be AAKCE3344D).',
      '5: State does not match the GSTIN (29 is Karnataka).',
    ]);
    expect(preview.tables[0]).toMatchObject({ rows: 5, errors: 4, ready: 1 });
    expect((await confirm(preview.id)).statusCode).toBe(409);
    expect(await erpCounts()).toEqual(EMPTY);
  });
});

describe('items', () => {
  it('imports valid items', async () => {
    const preview = await check(
      workbook({
        items: [PAPER, ['TONER-88A', 'Printer Toner Cartridge 88A', '8443', 'Nos', '18%']],
      }),
    );
    expect(preview.canConfirm).toBe(true);
    await confirm(preview.id);
    expect((await app.veyra.erp.listItems()).map((i) => [i.code, i.uom, i.gstRateBp])).toEqual([
      ['PAPER-A4', 'REAM', 1200],
      ['TONER-88A', 'NOS', 1800],
    ]);
  });

  it('refuses bad HSN, unknown units, bad rates and duplicates (the demo error file)', async () => {
    const preview = await check(fixture('Demo-Items-With-Errors.xlsx'));
    expect(preview.errors.map((e) => `${e.row} ${e.column}: ${e.message}`)).toEqual([
      '3 Item code: Item code is missing.',
      '4 HSN/SAC: HSN/SAC “73” must have 4, 6 or 8 digits.',
      '5 Unit: Unit “BUNDLE” is not a recognised unit. Use KGS, NOS, PCS, REAM, BOX, MTR, LTR or SET.',
      '6 Item code: Item code ITM-101 also appears on row 2.',
    ]);
    expect(preview.tables[0]).toMatchObject({ rows: 5, ready: 1, errors: 4 });
    expect(await erpCounts()).toEqual(EMPTY);
  });
});

describe('purchase orders and goods receipts', () => {
  const po = [['PO-X-1', 'SUP-01', '2026-09-01', 'open']];
  const poLines = [['PO-X-1', '1', 'PAPER-A4', '40', '245.00', '12', 'REAM']];
  const grn = [['GRN-X-1', 'PO-X-1', '2026-09-02']];
  const grnLines = [['GRN-X-1', '1', 'PAPER-A4', '40', '40', 'REAM']];

  it('imports a PO with lines and a GRN with lines, together with their vendor and item', async () => {
    const preview = await check(
      workbook({
        vendors: [NANDI],
        items: [PAPER],
        purchaseOrders: po,
        purchaseOrderLines: poLines,
        grns: grn,
        grnLines,
      }),
    );
    expect(preview.errors).toEqual([]);
    const done = (await confirm(preview.id)).json<ApiImport>();
    expect(done.result?.created).toEqual({ vendors: 1, items: 1, purchaseOrders: 1, grns: 1 });
    const imported = await app.veyra.erp.getPurchaseOrderByNumber('PO-X-1');
    expect(imported).toMatchObject({
      vendorId: 'SUP-01',
      origin: 'imported',
      lines: [
        {
          lineNo: 1,
          itemId: 'PAPER-A4',
          qtyMilli: 40_000,
          unitPricePaise: 24_500,
          gstRateBp: 1200,
        },
      ],
    });
    expect((await app.veyra.erp.listGrnsForPo(imported?.id as never))[0]).toMatchObject({
      grnNumber: 'GRN-X-1',
      lines: [{ acceptedQtyMilli: 40_000 }],
    });
  });

  it('a PO line for a vendor or item that exists nowhere fails validation; nothing is created', async () => {
    const preview = await check(
      workbook({
        purchaseOrders: [['PO-X-1', 'NOPE', '2026-09-01', 'open']],
        purchaseOrderLines: [['PO-X-1', '1', 'MISSING', '1', '1.00', '18', '']],
      }),
    );
    expect(preview.errors.map((e) => e.message)).toEqual([
      'Item MISSING is not in your records or in this upload.',
      'Vendor NOPE is not in your records or in this upload.',
    ]);
    expect(await erpCounts()).toEqual(EMPTY);
  });

  it('references existing records: POs against imported vendors and items, GRNs against imported POs', async () => {
    await confirm((await check(workbook({ vendors: [NANDI], items: [PAPER] }))).id);
    await confirm((await check(workbook({ purchaseOrders: po, purchaseOrderLines: poLines }))).id);
    const preview = await check(workbook({ grns: grn, grnLines }));
    expect(preview.errors).toEqual([]);
    await confirm(preview.id);
    expect(await erpCounts()).toEqual({ vendors: 1, items: 1, pos: 1, grns: 1 });
  });

  it('refuses accepted > received, a receipt before its order, unknown PO lines and mismatched items', async () => {
    await confirm(
      (
        await check(
          workbook({
            vendors: [NANDI],
            items: [PAPER],
            purchaseOrders: po,
            purchaseOrderLines: poLines,
          }),
        )
      ).id,
    );
    const preview = await check(
      workbook({
        grns: [
          ['GRN-X-1', 'PO-X-1', '2026-08-30'],
          ['GRN-X-2', 'PO-NOPE', '2026-09-02'],
        ],
        grnLines: [
          ['GRN-X-1', '1', 'PAPER-A4', '40', '41', ''],
          ['GRN-X-1', '2', 'PAPER-A4', '1', '1', ''],
          ['GRN-X-2', '1', 'TONER', '1', '1', ''],
        ],
      }),
    );
    expect(preview.errors.map((e) => e.message)).toEqual([
      'Accepted quantity (41) is more than the received quantity (40).',
      'Receipt date 2026-08-30 is before the PO date (2026-09-01).',
      'Line 2 is not on PO-X-1.',
      'Purchase order PO-NOPE is not in your records or in this upload.',
    ]);
    expect((await erpCounts()).grns).toBe(0);
  });

  it('lines without their order, and orders without lines, are refused', async () => {
    const preview = await check(
      workbook({
        vendors: [NANDI],
        items: [PAPER],
        purchaseOrders: [['PO-X-2', 'SUP-01', '2026-09-01', 'open']],
        purchaseOrderLines: poLines,
      }),
    );
    expect(preview.errors.map((e) => e.message)).toEqual([
      'PO-X-1 is not on the Purchase orders sheet of this upload. Upload lines together with their order.',
      'Purchase order PO-X-2 has no lines. Add them on the Purchase order lines sheet.',
    ]);
  });
});

describe('the whole upload is checked first, and imports are atomic and repeatable', () => {
  it('one bad row anywhere blocks the whole upload; the ERP is untouched', async () => {
    const preview = await check(
      workbook({ vendors: [NANDI], items: [PAPER, ['BAD', 'Bad item', '12', 'KGS', '18']] }),
    );
    expect(preview).toMatchObject({ status: 'invalid', canConfirm: false, errorCount: 1 });
    expect(preview.tables.map((t) => [t.label, t.ready, t.errors])).toEqual([
      ['Vendors', 1, 0],
      ['Items', 1, 1],
    ]);
    const res = await confirm(preview.id);
    expect(res.statusCode).toBe(409);
    expect(await erpCounts()).toEqual(EMPTY);
  });

  it('if the ERP changes between preview and confirmation, nothing is imported', async () => {
    const preview = await check(
      workbook({
        vendors: [
          NANDI,
          [
            'SUP-02',
            'Eastline Office Supplies Pvt Ltd',
            '29AAKCE3344D1ZP',
            '',
            'Bengaluru',
            '',
            'yes',
          ],
        ],
      }),
    );
    expect(preview.canConfirm).toBe(true);
    // Meanwhile the same vendor code is created with other details.
    await confirm(
      (
        await check(
          workbook({
            vendors: [['SUP-02', 'Someone Else', '27AAACA4321M1ZT', '', 'Pune', '', 'yes']],
          }),
        )
      ).id,
    );
    const res = await confirm(preview.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_STATE' } });
    expect((await app.veyra.erp.listVendors()).map((v) => v.code)).toEqual(['SUP-02']);
    expect((await get<ApiImport>(`/api/v1/imports/${preview.id}`)).status).toBe('invalid');
  });

  it('uploading the same file twice creates nothing new; confirming twice is safe', async () => {
    const file = workbook({ vendors: [NANDI], items: [PAPER] });
    const first = await check(file);
    const done = (await confirm(first.id)).json<ApiImport>();
    expect((await confirm(first.id)).json<ApiImport>()).toEqual(done);
    const second = await check(file);
    expect(second.tables.map((t) => [t.label, t.ready, t.existing])).toEqual([
      ['Vendors', 0, 1],
      ['Items', 0, 1],
    ]);
    expect(second.canConfirm).toBe(false); // nothing new to import
    expect(await erpCounts()).toMatchObject({ vendors: 1, items: 1 });
  });

  it('an existing record with different details is an error, never an overwrite', async () => {
    await confirm((await check(workbook({ vendors: [NANDI] }))).id);
    const changed = [...NANDI];
    changed[4] = 'New address';
    const preview = await check(workbook({ vendors: [changed] }));
    expect(preview.errors.map((e) => e.message)).toEqual([
      'Vendor SUP-01 already exists with different details. Veyra does not change existing records.',
    ]);
    expect((await app.veyra.erp.listVendors())[0]?.address).toBe('Bengaluru');
  });

  it('reads files as written by Excel: sheet names, header labels, dates, percentages; never formulas', async () => {
    const preview = await check({
      filename: 'purchasing.xlsx',
      bytes: readFileSync(new URL('../test/fixtures/excel-style.xlsx', import.meta.url)),
    });
    expect(preview.errors.map((e) => `${e.table} row ${e.row}: ${e.message}`)).toEqual([
      'Goods receipt lines row 2: Accepted is a formula with no saved value. Veyra never calculates formulas: paste the value instead.',
    ]);
    expect(preview.notices).toContain(
      '“purchasing.xlsx › Notes” was not read: it is not one of the Veyra template sheets.',
    );
    expect(preview.tables.map((t) => [t.label, t.rows])).toEqual([
      ['Vendors', 2],
      ['Items', 2],
      ['Purchase orders', 1],
      ['Purchase order lines', 2],
      ['Goods receipts', 1],
      ['Goods receipt lines', 1],
    ]);
  });

  it('accepts CSV, skips template example rows, and refuses what is not a spreadsheet', async () => {
    const csv = await check(fixture('Demo-Vendors.csv'));
    expect(csv.tables).toEqual([expect.objectContaining({ label: 'Vendors', rows: 7, ready: 7 })]);
    const template = await check(fixture('templates/Veyra-Master-Data-Import.xlsx'));
    expect(template.notices).toContain(
      '1 example row on Veyra-Master-Data-Import.xlsx › Vendors skipped.',
    );
    expect(template.errors.map((e) => e.message)).toEqual([
      'There are no records to import in this upload.',
    ]);
    const junk = await check({
      filename: 'x.xls',
      bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]),
    });
    expect(junk.errors[0]?.message).toMatch(/Older .xls files are not supported/);
  });
});

describe('exports', () => {
  it('templates download as real workbooks with instructions and one example row', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/api/v1/imports/templates/Vendors.xlsx',
    });
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = readXlsx(res.rawPayload);
    expect(wb.sheets.map((s) => s.name)).toEqual(['How to fill in', 'Vendors']);
    expect(wb.sheets[1]?.rows.map((r) => r.cells[0]?.text)).toEqual(['vendor_code', 'EXAMPLE-V01']);
    expect(
      (await app.server.inject({ method: 'GET', url: '/api/v1/imports/templates/..%2Fsecret' }))
        .statusCode,
    ).toBe(404);
  });

  it('business records export in template format and re-import as "already exists"', async () => {
    await confirm((await check(fixture('Demo-Business-Records.xlsx'))).id);
    const res = await app.server.inject({
      method: 'GET',
      url: '/api/v1/exports/business-records.xlsx',
    });
    const again = await check({ filename: 'Business-records.xlsx', bytes: res.rawPayload });
    expect(again.errors).toEqual([]);
    expect(again.tables.every((t) => t.ready === 0 && t.existing === t.rows)).toBe(true);
  });

  it('processed invoices, decisions and the audit trail export with business columns', async () => {
    await confirm((await check(fixture('Demo-Business-Records.xlsx'))).id);
    const s08 = scenarioById('S08');
    if (!s08) throw new Error('S08');
    const upload = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart([{ filename: s08.file, bytes: renderScenario(s08) }]),
    });
    const { invoiceId } = upload.json<{ invoiceId: string }>();
    await app.runner.drain();
    const [q] = await get<ApiQuestion[]>('/api/v1/questions');
    await app.server.inject({
      method: 'POST',
      url: `/api/v1/questions/${q?.id}/answer`,
      payload: {
        optionId: 'confirm',
        input: { grnDate: '2026-09-20', lines: [{ poLineNo: 1, received: '50', accepted: '50' }] },
      },
    });
    await app.runner.drain();
    expect((await get<ApiInvoiceDetail>(`/api/v1/invoices/${invoiceId}`)).state).toBe(
      'VERIFIED_PENDING_PAYMENT',
    );

    const invoices = readXlsx(
      (await app.server.inject({ method: 'GET', url: '/api/v1/exports/invoices.xlsx' })).rawPayload,
    ).sheets[0]?.rows.map((r) => r.cells.map((c) => c.text));
    expect(invoices?.[0]).toEqual([
      'Invoice number',
      'Vendor',
      'Invoice date',
      'Amount (₹)',
      'Status',
      'Decision',
      'Decision date',
      'Ready for payment',
      'Note',
      'Received',
      'File',
    ]);
    expect(invoices?.[1]?.slice(0, 8)).toEqual([
      'APX-7790',
      'Apex Components Pvt Ltd',
      '2026-09-21',
      '8555.00',
      'Ready',
      'Yes, record the receipt',
      '2026-09-28 12:00',
      'Yes',
    ]);

    const decisions = readCsv(
      (await app.server.inject({ method: 'GET', url: '/api/v1/exports/decisions.csv' })).rawPayload,
      'd.csv',
    ).map((r) => r.cells.map((c) => c.text));
    expect(decisions[1]).toEqual([
      '2026-09-28 12:00',
      'APX-7790',
      'Apex Components Pvt Ltd',
      'Receipt not recorded',
      'Found the supplier and PO-2026-0104, but no goods receipt yet',
      'Yes, record the receipt',
      'Receipt recorded. It is written to your ERP with the invoice.',
      'You',
    ]);

    const audit = readCsv(
      (await app.server.inject({ method: 'GET', url: '/api/v1/exports/audit.csv' })).rawPayload,
      'a.csv',
    ).map((r) => r.cells.map((c) => c.text));
    expect(audit[0]).toEqual(['Date/time', 'Invoice', 'Action', 'Actor', 'Description']);
    expect(audit.slice(1).map((r) => `${r[1]} · ${r[3]} · ${r[2]}`)).toEqual(
      expect.arrayContaining([
        'Business records · You · Business records imported',
        'APX-7790 · You · Confirmed goods receipt',
        'APX-7790 · Veyra · Ready for payment',
      ]),
    );
    expect(
      (await app.server.inject({ method: 'GET', url: '/api/v1/exports/secrets.csv' })).statusCode,
    ).toBe(404);
  });
});

describe('audit and history', () => {
  it('import actions appear in the audit trail as You and Veyra, and in the import history', async () => {
    const preview = await check(fixture('Demo-Business-Records.xlsx'));
    await confirm(preview.id);
    const trail = await get<ApiAuditEntry[]>('/api/v1/audit?scope=records');
    expect(trail.map((e) => `${e.by}: ${e.title}`)).toEqual([
      'You: Business records uploaded',
      'You: Business records imported',
      'Veyra: 39 records added',
    ]);
    expect(trail[2]?.detail).toBe(
      '7 vendors, 7 items, 13 purchase orders, 12 goods receipts added to your business records.',
    );
    const history = await get<ApiImport[]>('/api/v1/imports');
    expect(history[0]).toMatchObject({
      files: ['Demo-Business-Records.xlsx'],
      status: 'imported',
      kinds:
        'Vendors, Items, Purchase orders, Purchase order lines, Goods receipts, Goods receipt lines',
    });
  });
});
