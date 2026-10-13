import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErpUnsupportedOperationError } from '@veyra/erp-connector';
import type {
  ApiErpConnectionState,
  ApiErpTest,
  ApiInvoiceDetail,
  ApiInvoiceSummary,
} from '@veyra/shared';
import * as t from '../db/schema';
import { Secret } from '../secret';
import { createTestApp } from '../test/app';
import { SAMPLE_API_KEY } from './sample/api';

/**
 * The ERP API connection end to end, through the real pipeline: the built-in Sample ERP (a made-up
 * business behind an API with its own field names) is connected with its preset, synced, and used
 * for checks; the demo's made-up invoices are then checked against its records. Covers a match
 * (verified with nothing written to the ERP), quantity and rate differences, a missing goods
 * receipt (never created, never passed), a bill the ERP already holds (duplicate), records out of
 * date (held, then checked after a sync), and switching back to the built-in records.
 */

let app: Awaited<ReturnType<typeof createTestApp>>;
let dir: string;
const now = new Date('2026-09-28T06:30:00.000Z');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-erp-api-'));
  app = await createTestApp({
    dataDir: dir,
    demo: false,
    allowFixtureExtractor: false,
    nodeEnv: 'test',
    clock: () => now,
    erpApi: {
      secretsKey: new Secret(randomBytes(32).toString('base64')),
      sampleErp: true,
      syncMinutes: 0,
    },
  });
  app.runner.stop();
}, 60_000);
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const inject = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.server.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function upload(key: string): Promise<string> {
  const res = await inject('POST', `/api/v1/erp/sample-invoices/${key}`);
  expect(res.statusCode, res.body).toBeLessThan(300);
  const { invoiceId } = res.json<{ invoiceId: string }>();
  await app.runner.drain();
  return invoiceId;
}
const detail = async (id: string) =>
  (await inject('GET', `/api/v1/invoices/${id}`)).json<ApiInvoiceDetail>();

describe('ERP API connection: the Sample ERP through the real pipeline', () => {
  it('connects with the preset, tests, syncs, and is used for checks', async () => {
    const before = (
      await inject('GET', '/api/v1/erp/api-connection')
    ).json<ApiErpConnectionState>();
    expect(before).toMatchObject({
      sampleErp: true,
      connection: null,
      canManage: true,
      canStoreSecrets: true,
    });

    const preset = (
      await inject('GET', '/api/v1/erp/api-connection/presets/sample')
    ).json<unknown>();
    expect((await inject('PUT', '/api/v1/erp/api-connection', preset)).statusCode).toBe(200);
    // Not usable before a complete sync.
    expect((await inject('POST', '/api/v1/erp/api-connection/activate')).statusCode).toBe(409);
    const secret = await inject('PUT', '/api/v1/erp/api-connection/secret', {
      value: SAMPLE_API_KEY,
    });
    expect(secret.statusCode).toBe(200);
    expect(secret.body).not.toContain(SAMPLE_API_KEY);

    const test = (await inject('POST', '/api/v1/erp/api-connection/check')).json<ApiErpTest>();
    expect(test.ok).toBe(true);
    expect(test.entities.map((e) => e.entity)).toEqual([
      'vendors',
      'items',
      'purchase_orders',
      'grns',
      'bills',
    ]);

    const sync = await inject('POST', '/api/v1/erp/sync');
    expect(sync.statusCode).toBe(200);
    const state = sync.json<ApiErpConnectionState>();
    expect(state.freshness.fresh).toBe(true);
    expect(state.runs[0]?.status).toBe('succeeded');
    expect(state.records).toMatchObject({
      vendors: 7,
      items: 7,
      purchase_orders: 13,
      grns: 12,
      bills: 1,
    });

    expect((await inject('POST', '/api/v1/erp/api-connection/activate')).statusCode).toBe(200);
    expect(app.veyra.erp.capabilities()).not.toContain('purchase_invoice.create');
  });

  it('a matching invoice is verified against the ERP records, with nothing written to the ERP', async () => {
    const id = await upload('match');
    const d = await detail(id);
    expect(d.state).toBe('VERIFIED_PENDING_PAYMENT');
    expect(await app.veyra.db.select().from(t.erpWrites)).toEqual([]);
    expect(await app.veyra.db.select().from(t.creationActions)).toEqual([]);
    // Traceable to the ERP's own records and when they were synced.
    expect(d.erp.sources?.map((s) => s.entity).sort()).toEqual(
      expect.arrayContaining(['vendors', 'purchase_orders', 'grns']),
    );
    const events = (
      await app.veyra.db.select().from(t.auditEvents).where(eq(t.auditEvents.invoiceId, id))
    ).map((e) => e.event);
    expect(events).toContain('erp.read_only_verified');
    expect(events).not.toContain('commit.completed');
  });

  it('a quantity difference and a rate difference are stopped by the existing checks', async () => {
    for (const key of ['quantity', 'rate']) {
      const d = await detail(await upload(key));
      expect(d.state, key).toBe('NEEDS_INPUT');
      expect(
        d.questions.some((q) => q.code.startsWith('VF_')),
        key,
      ).toBe(true);
    }
  });

  it('a missing goods receipt is never created and never passed: record it in the ERP, then check again', async () => {
    const d = await detail(await upload('no-receipt'));
    expect(d.state).toBe('NEEDS_INPUT');
    const q = d.questions.find((x) => x.code === 'CA_GRN' || x.code === 'VF_R26');
    expect(q).toBeDefined();
    const effects = q?.options.map((o) => o.id) ?? [];
    expect(effects).toContain('recheck');
    expect(effects).not.toContain('confirm');
    expect(q?.options.find((o) => o.id === 'recheck')?.label).toMatch(/our ERP/);
  });

  it('a bill the ERP already holds is flagged as a duplicate', async () => {
    const d = await detail(await upload('duplicate'));
    expect(d.state).toBe('NEEDS_INPUT');
    expect(d.questions.map((q) => q.code)).toContain('VF_R11');
  });

  it('every ERP write is refused while the API connection is used', async () => {
    await expect(
      app.veyra.erp.createVendor(
        { name: 'X', gstin: '29AAACS1111A1Z6', address: 'Y' } as never,
        'veyra:import:x' as never,
      ),
    ).rejects.toBeInstanceOf(ErpUnsupportedOperationError);
  });

  it('records out of date hold new invoices (never checked on old data), and a sync releases them', async () => {
    // The records are no longer known to be current (as if older than the limit), and the ERP
    // now refuses the login: the refresh before the check fails.
    await app.veyra.db.delete(t.erpSyncState);
    await inject('PUT', '/api/v1/erp/api-connection/secret', { value: 'not-the-key' });
    const bytes = new Uint8Array(
      readFileSync(
        new URL('../../../../fixtures/documents/D06-unreadable-total.pdf', import.meta.url),
      ),
    );
    const { invoiceId } = await app.veyra.upload({ filename: 'D06-unreadable-total.pdf', bytes });
    await app.runner.drain();
    expect((await app.veyra.invoiceRow(app.veyra.db, invoiceId)).state).toBe('MATCHING');
    const summary = (await inject('GET', '/api/v1/invoices')).json<{
      invoices: ApiInvoiceSummary[];
    }>();
    expect(summary.invoices.find((i) => i.id === invoiceId)?.note).toBe(
      'Waiting for up-to-date records from your ERP',
    );
    const state = (await inject('GET', '/api/v1/erp/api-connection')).json<ApiErpConnectionState>();
    expect(state.freshness.fresh).toBe(false);
    expect(state.runs[0]).toMatchObject({
      status: 'failed',
      errorCode: 'ERP_AUTHENTICATION_FAILED',
    });
    expect(JSON.stringify(state)).not.toContain('not-the-key');

    // The admin fixes the key and syncs: the held invoice is checked against fresh records.
    await inject('PUT', '/api/v1/erp/api-connection/secret', { value: SAMPLE_API_KEY });
    expect(
      (await inject('POST', '/api/v1/erp/sync')).json<ApiErpConnectionState>().freshness.fresh,
    ).toBe(true);
    await app.runner.drain();
    expect((await app.veyra.invoiceRow(app.veyra.db, invoiceId)).state).not.toBe('MATCHING');
    const events = (
      await app.veyra.db.select().from(t.auditEvents).where(eq(t.auditEvents.invoiceId, invoiceId))
    ).map((e) => e.event);
    expect(events.filter((e) => e === 'erp.check_held')).toHaveLength(1);
  });

  it('a sync that changed nothing does not re-check invoices waiting on the ERP; one that did, does', async () => {
    const id = await upload('no-receipt');
    expect((await detail(id)).state).toBe('NEEDS_INPUT');
    expect(await app.veyra.recheckAfterErpSync(false)).toBe(0);
    expect((await app.veyra.invoiceRow(app.veyra.db, id)).state).toBe('NEEDS_INPUT');
    expect(await app.veyra.recheckAfterErpSync(true)).toBeGreaterThan(0);
    expect((await app.veyra.invoiceRow(app.veyra.db, id)).state).toBe('MATCHING');
    await app.runner.drain();
  });

  it('does not switch records while an invoice is being recorded', async () => {
    const id = await upload('match');
    const before = (await app.veyra.invoiceRow(app.veyra.db, id)).state;
    await app.veyra.db.update(t.invoices).set({ state: 'COMMITTING' }).where(eq(t.invoices.id, id));
    try {
      expect((await inject('POST', '/api/v1/erp/api-connection/deactivate')).statusCode).toBe(409);
      expect((await inject('POST', '/api/v1/erp/api-connection/activate')).statusCode).toBe(409);
      expect(app.veyra.erp.capabilities()).not.toContain('purchase_invoice.create');
    } finally {
      await app.veyra.db.update(t.invoices).set({ state: before }).where(eq(t.invoices.id, id));
    }
  });

  it('switching back restores the built-in records exactly', async () => {
    expect((await inject('POST', '/api/v1/erp/api-connection/deactivate')).statusCode).toBe(200);
    expect(app.veyra.erp.capabilities()).toContain('purchase_invoice.create');
    expect(
      (await inject('GET', '/api/v1/erp/api-connection')).json<ApiErpConnectionState>().connection
        ?.active,
    ).toBe(false);
  });
});
