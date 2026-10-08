import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiDataSource,
  ApiInvoiceDetail,
  ApiSourceInspect,
  ApiSourcePreview,
  ApiSourcesInfo,
} from '@veyra/shared';
import type { createApp } from '../app';
import * as t from '../db/schema';
import { readCsv } from '../spreadsheet/csv';
import { writeXlsx, type SheetRow } from '../spreadsheet/xlsx';
import { testSession } from '../test/auth';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';
import { SheetsError, type SheetsReader } from './sheets';

/**
 * Spreadsheet registers end to end: a purchase register kept in Excel or a Google Sheet (a fake
 * Google here), mapped once, synced, and an invoice checked against it. The invoice
 * (fixtures/documents/D15-tally-style.pdf) and the register rows are synthetic: a made-up
 * supplier.
 */
const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd';
const LINK = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`;

/** A Google Sheet whose rows the test sets; counts every read. */
class FakeSheets implements SheetsReader {
  readonly serviceEmail = 'veyrafy-sheets@veyrafy-test.iam.gserviceaccount.com';
  rows: SheetRow[] = [];
  reads = 0;
  failWith: SheetsError | null = null;
  async open(id: string) {
    if (this.failWith) throw this.failWith;
    if (id !== SHEET_ID)
      throw new SheetsError("This link doesn't open a Google Sheet.", 'not_found');
    return { title: 'Purchases 2025-26', tabs: [{ title: 'Register', gid: 0 }] };
  }
  async readTab() {
    this.reads += 1;
    await new Promise((r) => setTimeout(r, 20));
    if (this.failWith) throw this.failWith;
    return this.rows;
  }
}

const HEADER = [
  'Bill #',
  'Vendor A/c',
  'Bill Dt.',
  'Material',
  'Qnty',
  'Price',
  'Taxable Value',
  'CGST Amt',
  'SGST Amt',
  'Bill Total',
];
const line = (item: string, rate: string) => [
  '13839',
  'Sample Electrical and Hardware',
  '09/12/2025',
  item,
  '1',
  rate,
  rate,
  (Number(rate) * 0.09).toFixed(2),
  (Number(rate) * 0.09).toFixed(2),
  '5640.00',
];
const registerRows = (mirrorRate: string, header = HEADER) => [
  ['Purchase register FY 2025-26'],
  [],
  header,
  line('MIRROR', mirrorRate),
  line('WOOD SCREW 2"', '40'),
  line('GATTA', '40'),
  line('COOLIE', '1250'),
];
const xlsx = (rows: string[][]) =>
  Buffer.from(
    writeXlsx([{ name: 'Register', widths: rows[2]?.map(() => 14) ?? [], rows, header: false }]),
  ).toString('base64');
const csvRows = (rows: string[][]) =>
  readCsv(
    new TextEncoder().encode(
      rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n'),
    ),
    'g.csv',
  );

const MAPPING = {
  invoiceNo: 0,
  supplier: 1,
  date: 2,
  item: 3,
  qty: 4,
  rate: 5,
  amount: 6,
  cgst: 7,
  sgst: 8,
  total: 9,
};
const LAYOUT = { sheetTitle: 'Register', headerRow: 3, mapping: MAPPING };

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;
const sheets = new FakeSheets();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-sources-'));
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    demoBusiness: 'brewery',
    allowFixtureExtractor: false,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
    sheets: { reader: sheets, refreshMinutes: 15 },
  });
  app.runner.stop();
}, 60_000);
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await app.server.inject({ method: 'POST', url: '/api/v1/dev/reset', payload: { erp: 'empty' } });
  app.runner.stop();
  sheets.rows = csvRows(registerRows('3450'));
  sheets.reads = 0;
  sheets.failWith = null;
});

const post = (url: string, payload: unknown) =>
  app.server.inject({ method: 'POST', url, payload: payload as object });
const info = async () =>
  (await app.server.inject({ method: 'GET', url: '/api/v1/sources' })).json<ApiSourcesInfo>();

async function uploadInvoice(name: string): Promise<string> {
  const boundary = '----veyra-sources-test';
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/v1/documents',
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      readFileSync(new URL(name, DOCS)),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  await app.runner.drain();
  return res.json<{ invoiceId: string }>().invoiceId;
}
const detail = async (id: string) =>
  (
    await app.server.inject({ method: 'GET', url: `/api/v1/invoices/${id}` })
  ).json<ApiInvoiceDetail>();

describe('a register uploaded as Excel', () => {
  for (const [rate, verdict] of [
    ['3450', 'cleared'],
    ['3400', 'mismatch'],
  ] as const)
    it(`is mapped once, synced, and an invoice is checked against it (MIRROR at ${rate} → ${verdict})`, async () => {
      const origin = {
        kind: 'upload',
        filename: 'purchase-register.xlsx',
        contentBase64: xlsx(registerRows(rate)),
      };
      const inspected = await post('/api/v1/sources/inspect', { origin });
      expect(inspected.statusCode, inspected.body).toBe(200);
      const tab = inspected.json<ApiSourceInspect>().tabs[0];
      // The header under the title rows is found, and the odd column names are proposed.
      expect(tab).toMatchObject({ title: 'Register', headerRow: 3, rows: 4, proposed: MAPPING });
      expect(tab?.columns[3]).toEqual({
        index: 3,
        header: 'Material',
        samples: ['MIRROR', 'WOOD SCREW 2"', 'GATTA'],
      });

      const preview = (
        await post('/api/v1/sources/preview', { origin, layout: LAYOUT })
      ).json<ApiSourcePreview>();
      expect(preview).toMatchObject({
        invoices: 1,
        lines: 4,
        unmappedRequired: [],
        errorCount: 0,
        warningCount: 0,
      });
      // Without a supplier column nothing can be saved.
      const half = await post('/api/v1/sources/preview', {
        origin,
        layout: { ...LAYOUT, mapping: { invoiceNo: 0, item: 3 } },
      });
      expect(half.json<ApiSourcePreview>()).toMatchObject({
        unmappedRequired: ['supplier'],
        errorCount: 0,
      });
      const refused = await post('/api/v1/sources', {
        origin,
        layout: { ...LAYOUT, mapping: { invoiceNo: 0, item: 3 } },
        name: 'Register',
      });
      expect(refused.statusCode).toBe(422);

      const created = await post('/api/v1/sources', {
        origin,
        layout: LAYOUT,
        name: 'Purchase register',
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json<ApiDataSource>()).toMatchObject({
        kind: 'upload',
        records: 1,
        lastSync: { status: 'ok', invoices: 1, imported: 1 },
      });

      const inv = await detail(await uploadInvoice('D15-tally-style.pdf'));
      expect(inv.comparison?.verdict).toBe(verdict);
      expect(inv.state).toBe(verdict === 'cleared' ? 'VERIFIED_PENDING_PAYMENT' : 'NEEDS_INPUT');
    }, 120_000);

  it('syncing the same register again adds nothing; an uploaded register needs its file to sync', async () => {
    const origin = {
      kind: 'upload',
      filename: 'register.xlsx',
      contentBase64: xlsx(registerRows('3450')),
    };
    const src = (
      await post('/api/v1/sources', { origin, layout: LAYOUT, name: 'Register' })
    ).json<ApiDataSource>();
    const again = await post(`/api/v1/sources/${src.id}/sync`, { origin });
    expect(again.json<ApiDataSource>()).toMatchObject({
      records: 1,
      lastSync: { status: 'ok', imported: 0 },
    });
    expect((await post(`/api/v1/sources/${src.id}/sync`, {})).statusCode).toBe(422);
    // Turned off: kept, not synced.
    const off = await app.server.inject({
      method: 'PATCH',
      url: `/api/v1/sources/${src.id}`,
      payload: { enabled: false },
    });
    expect(off.json<ApiDataSource>().enabled).toBe(false);
    expect((await post(`/api/v1/sources/${src.id}/sync`, { origin })).statusCode).toBe(422);
  });

  it('only people who manage imports, on a plan that has it, can add a source', async () => {
    const origin = {
      kind: 'upload',
      filename: 'register.xlsx',
      contentBase64: xlsx(registerRows('3450')),
    };
    const reviewer = (await testSession(app, { role: 'REVIEWER' })).headers;
    expect(
      (
        await app.server.inject({
          method: 'POST',
          url: '/api/v1/sources/inspect',
          payload: { origin },
          headers: reviewer,
        })
      ).statusCode,
    ).toBe(403);
    // Reviewers do not see ERP data at all; the finance team reads and manages sources.
    expect(
      (await app.server.inject({ method: 'GET', url: '/api/v1/sources', headers: reviewer }))
        .statusCode,
    ).toBe(403);
    const finance = (await testSession(app, { role: 'FINANCE' })).headers;
    expect(
      (
        await app.server.inject({
          method: 'POST',
          url: '/api/v1/sources/inspect',
          payload: { origin },
          headers: finance,
        })
      ).statusCode,
    ).toBe(200);
    await app.veyra.db
      .update(t.planEntitlements)
      .set({ enabled: false })
      .where(eq(t.planEntitlements.capability, 'erp.spreadsheet_sources'));
    app.veyra.entitlements.invalidate();
    try {
      expect((await post('/api/v1/sources/inspect', { origin })).statusCode).toBe(403);
    } finally {
      await app.veyra.db
        .update(t.planEntitlements)
        .set({ enabled: true })
        .where(eq(t.planEntitlements.capability, 'erp.spreadsheet_sources'));
      app.veyra.entitlements.invalidate();
    }
  });
});

describe('a register kept in a Google Sheet', () => {
  it('is connected by its link, and says which address to share it with', async () => {
    expect(await info()).toMatchObject({
      google: true,
      serviceEmail: sheets.serviceEmail,
      refreshMinutes: 15,
    });
    const bad = await post('/api/v1/sources/inspect', {
      origin: { kind: 'google_sheet', link: 'https://example.com/sheet' },
    });
    expect(bad.statusCode).toBe(422);
    sheets.failWith = new SheetsError(
      `Share this sheet with ${sheets.serviceEmail} as Viewer.`,
      'not_shared',
    );
    const unshared = await post('/api/v1/sources/inspect', {
      origin: { kind: 'google_sheet', link: LINK },
    });
    expect(unshared.statusCode).toBe(422);
    expect(unshared.json<{ error: { message: string } }>().error.message).toContain(
      sheets.serviceEmail,
    );
    sheets.failWith = null;
    const ok = (
      await post('/api/v1/sources/inspect', { origin: { kind: 'google_sheet', link: LINK } })
    ).json<ApiSourceInspect>();
    expect(ok).toMatchObject({
      kind: 'google_sheet',
      name: 'Purchases 2025-26',
      spreadsheetId: SHEET_ID,
    });
    expect(ok.tabs[0]?.proposed).toEqual(MAPPING);
  });

  it('stops when the columns change, never reading through a stale mapping', async () => {
    const src = (
      await post('/api/v1/sources', {
        origin: { kind: 'google_sheet', link: LINK },
        layout: LAYOUT,
        name: 'Purchases',
      })
    ).json<ApiDataSource>();
    expect(src).toMatchObject({ kind: 'google_sheet', spreadsheetId: SHEET_ID, records: 1 });
    // Someone inserts a column: the saved mapping would now read the wrong values.
    sheets.rows = csvRows(registerRows('3400', ['Bill #', 'Remarks', ...HEADER.slice(1)]));
    const synced = (await post(`/api/v1/sources/${src.id}/sync`, {})).json<ApiDataSource>();
    expect(synced.lastSync).toMatchObject({ status: 'columns_changed', imported: 0 });
    expect(synced.lastSync?.message).toMatch(/Review the mapping; nothing was read/);
    expect(synced.records).toBe(1);
  });

  it('is read again before a check when stale, once for many invoices; Google down never blocks', async () => {
    const src = (
      await post('/api/v1/sources', {
        origin: { kind: 'google_sheet', link: LINK },
        layout: LAYOUT,
        name: 'Purchases',
      })
    ).json<ApiDataSource>();
    await app.veyra.db
      .update(t.dataSources)
      .set({ lastSyncedAt: '2026-09-01T00:00:00.000Z' })
      .where(eq(t.dataSources.id, src.id));
    sheets.reads = 0;
    // Five checks at once share one read of the sheet.
    await Promise.all([1, 2, 3, 4, 5].map(() => app.veyra.beforeReceiptCheck?.()));
    expect(sheets.reads).toBe(1);
    // Fresh now: no read at all.
    await app.veyra.beforeReceiptCheck?.();
    expect(sheets.reads).toBe(1);
    // Stale and Google unavailable: recorded, and the stored records stay in use.
    await app.veyra.db
      .update(t.dataSources)
      .set({ lastSyncedAt: '2026-09-01T00:00:00.000Z' })
      .where(eq(t.dataSources.id, src.id));
    sheets.failWith = new SheetsError(
      'Google Sheets is unavailable; the last synced records are used.',
      'unavailable',
    );
    await expect(app.veyra.beforeReceiptCheck?.()).resolves.toBeUndefined();
    const after = (await info()).sources[0];
    expect(after).toMatchObject({ records: 1, lastSync: { status: 'failed' } });
  });

  it('records what happened in the audit trail, never a value from the sheet', async () => {
    await post('/api/v1/sources', {
      origin: { kind: 'google_sheet', link: LINK },
      layout: LAYOUT,
      name: 'Purchases',
    });
    const events = await app.veyra.db
      .select()
      .from(t.auditEvents)
      .where(like(t.auditEvents.event, 'source.%'));
    expect(events.map((e) => e.event)).toEqual(['source.saved', 'source.synced']);
    const text = JSON.stringify(events);
    for (const value of ['Sample Electrical', '13839', 'MIRROR', '3450'])
      expect(text).not.toContain(value);
  });
});
