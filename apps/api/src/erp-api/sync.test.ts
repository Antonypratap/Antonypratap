import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Company } from '@veyra/erp-connector';
import { computeGstinCheckChar } from '@veyra/india-tax';
import { openVeyraDb, type VeyraDatabase } from '../db/open';
import * as t from '../db/schema';
import { Secret } from '../secret';
import { createTestDatabase, type TestDatabase } from '../test/database';
import type { HttpRequest } from './http';
import { SAMPLE_PRESET } from './presets';
import {
  SAMPLE_API_KEY,
  sampleErpTransport,
  type SampleDataset,
  type SampleFault,
} from './sample/api';
import { ErpApi } from './service';
import { SyncBusyError } from './sync';

/**
 * Syncing an ERP's records over its API into the mirror, against the in-memory Sample ERP API
 * with made-up records. Covers paging, idempotency, incremental syncs, interruption, failures,
 * unreadable records, missing records, conflicts and links that do not resolve.
 */

/** Made-up GSTINs with a correct check character. */
const gstin = (first14: string) => first14 + computeGstinCheckChar(first14);
const GSTIN_A = gstin('29AABCS1234F1Z');
const GSTIN_B = gstin('27AAACB5678K1Z');
const COMPANY: Company = {
  id: 'C1' as never,
  name: 'Made-up Buyer Pvt Ltd',
  gstin: '29AAACM9999A1Z3' as never,
  stateCode: '29' as never,
};

function dataset(vendorCount = 3): SampleDataset {
  const vendors = Array.from({ length: vendorCount }, (_, i) => ({
    vendor_code: `SUP-${String(i + 1).padStart(3, '0')}`,
    vendor_name: `Made-up Supplier ${String(i + 1)}`,
    gst_no: i === 0 ? GSTIN_A : i === 1 ? GSTIN_B : gstin(`29AABCT${String(1000 + i)}F1Z`),
    address: 'Somewhere, Bengaluru',
    status: 'Active',
    updated_at: '2026-10-01T00:00:00Z',
  }));
  return {
    vendors,
    items: [
      {
        item_code: 'ITM-1',
        item_name: 'Glass bottle 330ml',
        hsn: '7010',
        uom: 'NOS',
        gst_rate: 18,
        updated_at: '2026-10-01T00:00:00Z',
      },
      {
        item_code: 'ITM-2',
        item_name: 'Crown cap',
        hsn: '8309',
        uom: 'NOS',
        gst_rate: 18,
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    purchaseOrders: [
      {
        po_id: 'PO-ID-1',
        po_no: 'PO/26-27/0001',
        vendor_code: 'SUP-001',
        po_date: '01-10-2026',
        status: 'Open',
        updated_at: '2026-10-01T00:00:00Z',
        items: [
          { line_id: 'L1', item_code: 'ITM-1', qty: 1000, rate: '12.50', gst_rate: 18 },
          { line_id: 'L2', item_code: 'ITM-2', qty: 1000, rate: '0.80', gst_rate: 18 },
        ],
      },
    ],
    goodsReceipts: [
      {
        grn_id: 'GRN-ID-1',
        grn_no: 'GRN/0001',
        po_no: 'PO/26-27/0001',
        grn_date: '05-10-2026',
        updated_at: '2026-10-05T00:00:00Z',
        items: [
          { po_line_id: 'L1', qty_recd: 1000, qty_accepted: 990 },
          { item_code: 'ITM-2', qty_recd: 1000, qty_accepted: 1000 },
        ],
      },
    ],
    purchaseBills: [
      {
        bill_id: 'B1',
        bill_no: 'INV-777',
        vendor_code: 'SUP-002',
        bill_date: '2026-10-03',
        bill_amount: '1180.00',
        payment_status: 'Paid',
        updated_at: '2026-10-03T00:00:00Z',
      },
    ],
  };
}

let database: TestDatabase;
let opened: VeyraDatabase;
let data: SampleDataset;
let faults: Map<string, SampleFault[]>;
let requests: HttpRequest[];
let clock: Date;
let api: ErpApi;
let secretsKey: Secret;
const audits: string[] = [];

beforeEach(async () => {
  database = await createTestDatabase();
  opened = await openVeyraDb({ url: database.url, migrate: false, pool: { max: 2 } });
  data = dataset();
  faults = new Map();
  requests = [];
  audits.length = 0;
  clock = new Date('2026-10-10T06:00:00.000Z');
  secretsKey = new Secret(randomBytes(32).toString('base64'));
  api = new ErpApi({
    db: opened.db,
    now: () => clock.toISOString(),
    secretsKey,
    company: () => Promise.resolve(COMPANY),
    http: { minIntervalMs: 0, baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 2, timeoutMs: 200 },
    transportFor: () =>
      sampleErpTransport(() => data, { faults, pageSize: 2, onRequest: (r) => requests.push(r) }),
  });
  api.attach(
    (_tx, event) => {
      audits.push(event);
      return Promise.resolve();
    },
    () => Promise.resolve(),
  );
  // Small pages, so paging is exercised.
  const profile = structuredClone(SAMPLE_PRESET);
  for (const e of Object.values(profile.entities))
    if (e.paging.style === 'cursor') e.paging.size = 2;
  await api.saveProfile(profile, null);
  await api.saveSecret(SAMPLE_API_KEY, null);
  await api.init();
});

afterEach(async () => {
  await opened.close();
  await database.drop();
});

const records = async (entity: string) =>
  opened.db.select().from(t.erpSyncRecords).where(eq(t.erpSyncRecords.entity, entity));

describe('ERP API sync', () => {
  it('reads every page of every record type into Veyrafy records', async () => {
    const r = await api.sync('manual', null);
    expect(r.status).toBe('succeeded');
    expect(r.counts.vendors).toMatchObject({
      received: 3,
      mapped: 3,
      changed: 3,
      pages: 2,
      status: 'complete',
    });
    const index = await api.index();
    expect(index.vendors.size).toBe(3);
    const po = index.poByNumber('PO/26-27/0001');
    expect(po?.lines.map((l) => [l.lineNo, l.qtyMilli, l.unitPricePaise, l.gstRateBp])).toEqual([
      [1, 1_000_000, 1250, 1800],
      [2, 1_000_000, 80, 1800],
    ]);
    // A receipt line given by PO line id, and one given only by item: both resolve to one PO line.
    const grn = [...index.grns.values()][0];
    expect(grn?.lines.map((l) => [l.poLineId, l.acceptedQtyMilli])).toEqual([
      [po?.lines[0]?.id, 990_000],
      [po?.lines[1]?.id, 1_000_000],
    ]);
    expect(index.bills).toHaveLength(1);
    expect(audits).toEqual([
      'erp.connection_saved',
      'erp.credentials_updated',
      'erp.sync_started',
      'erp.sync_finished',
    ]);
    expect((await api.freshness()).fresh).toBe(true);
  });

  it('repeating a sync changes nothing (idempotent)', async () => {
    await api.sync('manual', null);
    const before = await records('vendors');
    clock = new Date('2026-10-10T06:30:00.000Z');
    // Even a full pass: forget the watermark so everything is read again.
    await opened.db.delete(t.erpSyncState);
    const r = await api.sync('manual', null);
    expect(r.counts.vendors).toMatchObject({ received: 3, changed: 0, unchanged: 3 });
    const after = await records('vendors');
    expect(after.map((x) => [x.erpId, x.rawHash, x.lastChangedRunId, x.firstSeenAt])).toEqual(
      before.map((x) => [x.erpId, x.rawHash, x.lastChangedRunId, x.firstSeenAt]),
    );
    expect(after).toHaveLength(3);
  });

  it('then reads only what changed (incremental), and updates a changed record', async () => {
    await api.sync('manual', null);
    (data.vendors[1] as Record<string, unknown>).vendor_name = 'Made-up Supplier Two (renamed)';
    (data.vendors[1] as Record<string, unknown>).updated_at = '2026-10-10T06:10:00Z';
    clock = new Date('2026-10-10T06:20:00.000Z');
    requests.length = 0;
    const r = await api.sync('manual', null);
    expect(r.counts.vendors).toMatchObject({ received: 1, changed: 1 });
    expect(
      requests.some((q) => q.url.searchParams.get('updated_since') === '2026-10-10T06:00:00.000Z'),
    ).toBe(true);
    expect((await api.index()).vendors.get('SUP-002' as never)?.name).toBe(
      'Made-up Supplier Two (renamed)',
    );
  });

  it('marks records the ERP no longer has as missing after a full pass, without deleting them', async () => {
    await api.sync('manual', null);
    data.vendors.pop();
    await opened.db.delete(t.erpSyncState);
    const r = await api.sync('manual', null);
    expect(r.counts.vendors?.missing).toBe(1);
    const rows = await records('vendors');
    expect(rows).toHaveLength(3);
    expect(rows.filter((x) => x.missingSince !== null).map((x) => x.erpId)).toEqual(['SUP-003']);
    expect((await api.index()).vendors.has('SUP-003' as never)).toBe(false);
  });

  it('continues an interrupted sync from where it stopped', async () => {
    data = dataset(7);
    // The ERP fails on the third vendors page (both attempts): the run fails, pages 1-2 are kept.
    let calls = 0;
    api = rebuild((req) => {
      if (req.url.pathname.endsWith('/vendors')) {
        calls++;
        if (calls === 3 || calls === 4) return { status: 503 };
      }
      return null;
    });
    const first = await api.sync('manual', null);
    expect(first.status).toBe('failed');
    expect(first.errorCode).toBe('ERP_UNAVAILABLE');
    expect(await records('vendors')).toHaveLength(4);
    requests.length = 0;
    const second = await api.sync('manual', null);
    expect(second.status).toBe('succeeded');
    // It asked for the third page first, not the first page again.
    const firstVendorAsk = requests.find((q) => q.url.pathname.endsWith('/vendors'));
    expect(firstVendorAsk?.url.searchParams.get('cursor')).toBe('4');
    expect(await records('vendors')).toHaveLength(7);
  });

  it('a refused login fails the run and keeps what was synced before', async () => {
    await api.sync('manual', null);
    await api.saveSecret('wrong-key', null);
    clock = new Date('2026-10-10T08:00:00.000Z');
    const r = await api.sync('manual', null);
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe('ERP_AUTHENTICATION_FAILED');
    expect((await api.index()).vendors.size).toBe(3);
    expect((await api.check()).status).toBe('AUTHENTICATION_FAILED');
  });

  it('rides out rate limiting and a timeout within the retry budget', async () => {
    faults.set('vendors', [{ kind: 'status', status: 429, retryAfter: '0' }]);
    faults.set('items', [{ kind: 'timeout' }]);
    const r = await api.sync('manual', null);
    expect(r.status).toBe('succeeded');
  });

  it('a changed answer shape stops trusting that record type only', async () => {
    await api.sync('manual', null);
    await opened.db.delete(t.erpSyncState);
    faults.set('items', [{ kind: 'reshape' }]);
    const r = await api.sync('manual', null);
    expect(r.status).toBe('partial');
    expect(r.counts.items?.status).toBe('shape_changed');
    expect(r.counts.vendors?.status).toBe('complete');
    const f = await api.freshness();
    expect(f.fresh).toBe(false);
    expect(f.stale).toContain('items');
    // The items synced before are still there (nothing deleted on a bad answer).
    expect((await api.index()).items.size).toBe(2);
    expect(
      (await api.issues()).some((i) => i.kind === 'shape_changed' && i.entity === 'items'),
    ).toBe(true);
  });

  it('too many unreadable records: the type is not trusted, and the issue names fields only', async () => {
    data.items.push({
      item_code: 'ITM-3',
      item_name: 'Label',
      hsn: '4821',
      uom: 'NOS',
      gst_rate: 'eighteen',
    });
    const r = await api.sync('manual', null);
    expect(r.counts.items).toMatchObject({ received: 3, invalid: 1, status: 'untrusted' });
    expect((await api.freshness()).stale).toContain('items');
    const issue = (await api.issues()).find((i) => i.entity === 'items' && i.kind === 'invalid');
    expect(issue).toMatchObject({ erpId: 'ITM-3', detail: ['gstRateBp'] });
    expect(JSON.stringify(await api.issues())).not.toContain('eighteen');
  });

  it('reports conflicts and links that do not resolve, and does not use those records', async () => {
    data.vendors.push({
      vendor_code: 'SUP-009',
      vendor_name: 'Same GSTIN Co',
      gst_no: GSTIN_A,
      status: 'Active',
      updated_at: '2026-10-01T00:00:00Z',
    });
    data.purchaseOrders.push({
      po_id: 'PO-ID-2',
      po_no: 'PO/26-27/0002',
      vendor_code: 'SUP-404',
      po_date: '02-10-2026',
      status: 'Open',
      items: [{ line_id: 'L1', item_code: 'ITM-1', qty: 1, rate: 1, gst_rate: 18 }],
    });
    data.goodsReceipts.push({
      grn_id: 'GRN-ID-2',
      grn_no: 'GRN/0002',
      po_no: 'PO/26-27/0001',
      grn_date: '06-10-2026',
      items: [{ item_code: 'ITM-404', qty_recd: 1, qty_accepted: 1 }],
    });
    await api.sync('manual', null);
    const index = await api.index();
    // Two suppliers with one GSTIN: a lookup by it finds nothing certain.
    expect(index.vendorByGstin(GSTIN_A)).toBeNull();
    expect(index.pos.has('PO-ID-2' as never)).toBe(false);
    expect(index.grns.has('GRN-ID-2' as never)).toBe(false);
    const kinds = index.issues.map((i) => `${i.entity}:${i.erpId}:${i.kind}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'vendors:SUP-001:conflict',
        'vendors:SUP-009:conflict',
        'purchase_orders:PO-ID-2:orphan',
        'grns:GRN-ID-2:orphan',
      ]),
    );
  });

  it('runs one sync at a time', async () => {
    const [a, b] = await Promise.all([api.sync('manual', null), api.sync('manual', null)]);
    expect(a.runId).toBe(b.runId);
    // Another process holding the lease: refused, not run twice.
    await opened.db.insert(t.erpSyncRuns).values({
      id: 'OTHER',
      connectionId: 'erp-api',
      trigger: 'scheduled',
      status: 'running',
      startedAt: clock.toISOString(),
      heartbeatAt: clock.toISOString(),
      countsJson: '{}',
      checkpointJson: '{}',
    });
    await expect(api.sync('manual', null)).rejects.toBeInstanceOf(SyncBusyError);
    // A lease whose heartbeat stopped is closed as interrupted, and the next sync runs.
    clock = new Date(clock.getTime() + 10 * 60_000);
    const r = await api.sync('manual', null);
    expect(r.status).toBe('succeeded');
    const [other] = await opened.db
      .select()
      .from(t.erpSyncRuns)
      .where(eq(t.erpSyncRuns.id, 'OTHER'));
    expect(other?.status).toBe('interrupted');
  });

  it('becomes stale after the age limit, and cannot be used for checks until fresh', async () => {
    await expect(api.activate(null)).rejects.toThrow();
    await api.sync('manual', null);
    await api.activate(null);
    expect(api.isActive()).toBe(true);
    clock = new Date(clock.getTime() + 61 * 60_000);
    const f = await api.freshness();
    expect(f.fresh).toBe(false);
    expect(f.syncedAt).toBe('2026-10-10T06:00:00.000Z');
    await api.deactivate(null);
    expect(api.isActive()).toBe(false);
  });

  it('stores the secret encrypted, and forgets it when the address changes', async () => {
    const [row] = await opened.db.select().from(t.erpCredentials);
    expect(row?.ciphertext).not.toContain(SAMPLE_API_KEY);
    expect(JSON.stringify(row)).not.toContain(SAMPLE_API_KEY);
    expect((await api.secretStatus())?.savedAt).not.toBeNull();
    await api.saveProfile({ ...SAMPLE_PRESET, baseUrl: 'https://erp.other.example' }, null);
    expect((await api.secretStatus())?.savedAt).toBeNull();
  });

  it('pointed at another ERP, forgets its records and stops being used for checks', async () => {
    await api.sync('manual', null);
    await api.activate(null);
    const current = (await api.profile())?.profile;
    if (!current) throw new Error('expected a profile');
    const saved = await api.saveProfile({ ...current, baseUrl: 'https://erp.other.example' }, null);
    expect(saved).toMatchObject({ reset: true, wasActive: true });
    expect(await opened.db.select().from(t.erpSyncRecords)).toEqual([]);
    expect(await opened.db.select().from(t.erpSyncState)).toEqual([]);
    expect(api.isActive()).toBe(false);
    expect((await api.profile())?.active).toBe(false);
    expect((await api.index()).vendors.size).toBe(0);
    expect((await api.freshness()).fresh).toBe(false);
    await expect(api.activate(null)).rejects.toThrow();
  });

  it('for another company or outlet (scope), forgets the records too', async () => {
    await api.sync('manual', null);
    const current = (await api.profile())?.profile;
    if (!current) throw new Error('expected a profile');
    const saved = await api.saveProfile(
      { ...current, scope: { ...current.scope, query: { company: 'OTHER' } } },
      null,
    );
    expect(saved.reset).toBe(true);
    expect(await opened.db.select().from(t.erpSyncRecords)).toEqual([]);
    // The secret stays: same address, same login.
    expect((await api.secretStatus())?.savedAt).not.toBeNull();
  });

  it('a changed mapping rewrites the records it reads, even when the ERP data did not change', async () => {
    await api.sync('manual', null);
    const current = (await api.profile())?.profile;
    if (!current?.entities.vendors) throw new Error('expected a vendors mapping');
    const remapped = structuredClone(current);
    if (!remapped.entities.vendors) throw new Error('expected a vendors mapping');
    remapped.entities.vendors.fields.name = { path: 'address' };
    const saved = await api.saveProfile(remapped, null);
    expect(saved.reset).toBe(false);
    clock = new Date('2026-10-10T06:30:00.000Z');
    const r = await api.sync('manual', null);
    // Vendors are read again in full and rewritten; other record types are untouched.
    expect(r.counts.vendors).toMatchObject({ received: 3, changed: 3 });
    expect(r.counts.items).toMatchObject({ changed: 0 });
    expect((await api.index()).vendors.get('SUP-001' as never)?.name).toBe('Somewhere, Bengaluru');
  });

  it('tells what follows a sync whether any record changed', async () => {
    const changed: boolean[] = [];
    api.attach(
      () => Promise.resolve(),
      (c) => {
        changed.push(c);
        return Promise.resolve();
      },
    );
    await api.sync('manual', null);
    clock = new Date('2026-10-10T06:30:00.000Z');
    await api.sync('manual', null);
    expect(changed).toEqual([true, false]);
  });

  it('after a failed sync, waits before checks call the ERP again', async () => {
    await api.sync('manual', null);
    await api.activate(null);
    await api.saveSecret('not-the-key', null);
    // Older than the limit: the next check wants a refresh, and the ERP refuses the login.
    clock = new Date(clock.getTime() + 61 * 60_000);
    requests.length = 0;
    await api.refreshIfStale();
    const afterFirst = requests.length;
    expect(afterFirst).toBeGreaterThan(0);
    // A minute later: no new call (a down ERP is not called once per waiting invoice).
    clock = new Date(clock.getTime() + 60_000);
    await api.refreshIfStale();
    expect(requests.length).toBe(afterFirst);
    // After the wait it tries again.
    clock = new Date(clock.getTime() + 2 * 60_000);
    await api.refreshIfStale();
    expect(requests.length).toBeGreaterThan(afterFirst);
  });
});

/** The API with a transport that can answer some requests itself (scripted faults). */
function rebuild(intercept: (req: HttpRequest) => { status: number } | null): ErpApi {
  const inner = sampleErpTransport(() => data, { pageSize: 2 });
  const next = new ErpApi({
    db: opened.db,
    now: () => clock.toISOString(),
    secretsKey,
    company: () => Promise.resolve(COMPANY),
    http: { minIntervalMs: 0, baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 2, timeoutMs: 200 },
    transportFor: () => (req, signal) => {
      requests.push(req);
      const r = intercept(req);
      return r
        ? Promise.resolve({ status: r.status, headers: {}, body: '{}' })
        : inner(req, signal);
    },
  });
  next.attach(
    () => Promise.resolve(),
    () => Promise.resolve(),
  );
  return next;
}
