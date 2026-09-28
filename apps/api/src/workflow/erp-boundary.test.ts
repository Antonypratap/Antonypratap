import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { renderScenario, scenarioById } from '@veyra/extractor';
import { ERP_CAPABILITIES, type ErpConnector, type PurchaseOrder } from '@veyra/erp-connector';
import { scriptedConnector, type ErpScript } from '@veyra/erp-connector/testing';
import { ApiErpSchema } from '@veyra/shared';
import * as t from '../db/schema';
import type { createApp } from '../app';
import { Presenter } from '../http/present';
import { DEMO_NOW, createHarness, type Harness } from '../test/harness';
import { createTestApp } from '../test/app';

/**
 * Phase 4: the ERP boundary as the workflow sees it. Every test runs Veyra against the fake ERP
 * wrapped in the scripted test connector, which injects what a production ERP can do: outages,
 * timeouts before and after a write, rejected credentials, missing capabilities, changed data.
 */
let h: Harness;
let script: ErpScript;
afterEach(async () => {
  await h?.close();
});

const SECRETS = /ECONNREFUSED|10\.20\.30\.40|Bearer|sk_test|hunter2|password|SQLITE_|at .*\.ts:\d+/;

async function scripted(options: Parameters<typeof scriptedConnector>[1] = {}) {
  h = await createHarness({
    wrapErp: (erp) => {
      const s = scriptedConnector(erp, options);
      script = s.script;
      return s.connector;
    },
  });
}

/** Uploads a scenario and runs only the pipeline job: validated, COMMITTING, commit job queued. */
async function validated(scenario: string): Promise<string> {
  const s = scenarioById(scenario);
  if (!s) throw new Error(scenario);
  const { invoiceId } = await h.veyra.upload({ filename: s.file, bytes: renderScenario(s) });
  await h.runner.step();
  expect(await h.state(invoiceId)).toBe('COMMITTING');
  return invoiceId;
}

/** The test clock is frozen: make delayed retries due now, then run them. */
async function runDueRetries(): Promise<void> {
  await h.veyra.db.update(t.jobs).set({ runAfter: '2000-01-01T00:00:00.000Z' });
  await h.runner.drain();
}

const audit = (id: string) =>
  h.veyra.db
    .select()
    .from(t.auditEvents)
    .where(eq(t.auditEvents.invoiceId, id))
    .orderBy(asc(t.auditEvents.seq));
const events = async (id: string) => (await audit(id)).map((e) => e.event);
const ledger = (id: string) =>
  h.veyra.db
    .select()
    .from(t.erpWrites)
    .where(eq(t.erpWrites.invoiceId, id))
    .orderBy(asc(t.erpWrites.seq));
const commitJob = async (id: string) =>
  (await h.veyra.latestJobs(id)).find((j) => j.type === 'commit');
const ours = async (id: string) =>
  (await h.erp.listPurchaseInvoices()).filter((p) => p.veyraInvoiceId === id);

/** Everything a user or API client could see about an invoice. */
async function visible(id: string): Promise<string> {
  const present = new Presenter(h.veyra);
  return JSON.stringify({
    detail: await present.detail(id),
    audit: await present.audit(id),
    jobs: await h.veyra.latestJobs(id),
    row: await h.veyra.invoiceRow(h.veyra.db, id),
  });
}

describe('ERP boundary: commit', () => {
  it('records every write in the ledger with its key, ERP id and external reference', async () => {
    await scripted();
    const id = await h.upload('S03');
    await h.answer(id, 'CA_GRN', 'confirm', {
      grnDate: '2026-09-17',
      lines: [{ poLineNo: 1, received: '40', accepted: '40' }],
    });
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    const rows = await ledger(id);
    expect(rows.map((r) => r.operation).sort()).toEqual([
      'createGrn',
      'createPurchaseOrder',
      'createVendor',
      'recordPurchaseInvoice',
    ]);
    for (const r of rows) {
      expect(r.status).toBe('confirmed');
      expect(r.idempotencyKey).toMatch(new RegExp(`^veyra:${id}:`));
      expect(r.erpId).toBeTruthy();
      expect(r.externalRef).toBeTruthy();
    }
    const pi = rows.find((r) => r.operation === 'recordPurchaseInvoice');
    expect(pi).toMatchObject({
      erpId: (await h.veyra.invoiceRow(h.veyra.db, id)).erpPurchaseInvoiceId,
    });
    expect(await events(id)).toContain('commit.started');
  });

  it('pre-commit re-check: a PO changed between validation and commit sends it back to matching', async () => {
    await scripted();
    const id = await validated('S01');
    // Someone edits the order's prices in the ERP after Veyra validated the invoice.
    const raise = (po: PurchaseOrder | null) =>
      po && {
        ...po,
        lines: po.lines.map((l) => ({ ...l, unitPricePaise: l.unitPricePaise + 500 })),
      };
    script.override('getPurchaseOrder', async (poId) =>
      raise(await h.erp.getPurchaseOrder(poId as never)),
    );
    script.override('getPurchaseOrderByNumber', async (n) =>
      raise(await h.erp.getPurchaseOrderByNumber(n as never)),
    );
    script.override('listOpenPurchaseOrders', async (vendorId) =>
      (await h.erp.listOpenPurchaseOrders(vendorId as never)).map((po) => raise(po)),
    );
    await h.runner.drain();
    expect(await events(id)).toContain('commit.conflict');
    expect(await events(id)).not.toContain('commit.started');
    expect(await h.state(id)).toBe('NEEDS_INPUT');
    expect((await h.openQuestions(id)).map((q) => q.code)).toContain('VF_R21');
    expect(await ours(id)).toHaveLength(0);
    expect(await ledger(id)).toEqual([]);
  });

  it('timeout BEFORE the write: nothing was sent, the retry uses the same key, one record', async () => {
    await scripted();
    const id = await validated('S01');
    script.fail('recordPurchaseInvoice', 'timeout_before_write');
    await h.runner.drain();
    expect(await h.state(id)).toBe('COMMITTING');
    expect(await commitJob(id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await ledger(id)).toMatchObject([{ status: 'not_created', errorCode: 'UNAVAILABLE' }]);
    expect(await events(id)).toContain('erp.unavailable');
    await runDueRetries();
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    expect(await ours(id)).toHaveLength(1);
    expect(await ledger(id)).toMatchObject([{ status: 'confirmed' }]);
  });

  it('timeout AFTER the write: reconciliation finds the transaction; it is never recorded twice', async () => {
    await scripted();
    const id = await validated('S01');
    script.fail('recordPurchaseInvoice', 'timeout_after_write');
    await h.runner.drain();
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    const [pi] = await ours(id);
    expect(await ours(id)).toHaveLength(1);
    expect(await ledger(id)).toMatchObject([{ status: 'confirmed', erpId: pi?.id }]);
    expect(await events(id)).toEqual(
      expect.arrayContaining(['erp.reconciled', 'commit.completed']),
    );
    expect(script.calls.filter((c) => c.operation === 'reconcileWrite')).toHaveLength(1);
  });

  it('outcome unknown and the ERP cannot say: stays unresolved, audited, never shown as ready', async () => {
    await scripted();
    const id = await validated('S01');
    // The response is lost, then the ERP stops answering altogether.
    script.fail('recordPurchaseInvoice', 'timeout_after_write');
    script.fail('reconcileWrite', 'unavailable');
    await h.runner.drain();
    expect(await ledger(id)).toMatchObject([{ status: 'unknown' }]);
    script.fail('findPurchaseInvoice', 'unavailable', 100);
    for (let i = 0; i < 6; i++) await runDueRetries(); // well past the normal retry budget
    expect(await h.state(id)).toBe('COMMITTING');
    expect(await ledger(id)).toMatchObject([
      { status: 'unknown', operation: 'recordPurchaseInvoice' },
    ]);
    expect((await events(id)).filter((e) => e === 'erp.reconciliation_required')).toHaveLength(1);
    expect(await events(id)).not.toContain('commit.completed');
    expect(await commitJob(id)).toMatchObject({ status: 'queued' });
    const shown = await visible(id);
    expect(shown).not.toMatch(/Ready for payment|Invoice ready|Recorded ERP transaction/);
    expect(shown).toContain('ERP transaction outcome requires reconciliation');
    expect(shown).not.toMatch(SECRETS);
    // The ERP answers again: the same key is confirmed, still exactly one record.
    script.clear();
    await runDueRetries();
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    expect(await ours(id)).toHaveLength(1);
    expect(await ledger(id)).toMatchObject([{ status: 'confirmed' }]);
    expect(await events(id)).toContain('erp.reconciled');
  });

  it('a staged creation whose response was lost is reconciled and not created twice', async () => {
    await scripted();
    const id = await h.upload('S03');
    script.fail('createVendor', 'timeout_after_write');
    await h.answer(id, 'CA_GRN', 'confirm', {
      grnDate: '2026-09-17',
      lines: [{ poLineNo: 1, received: '40', accepted: '40' }],
    });
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    expect(await h.erp.findVendorsByNormalizedName('nandi stationers')).toHaveLength(1);
    expect((await ledger(id)).find((r) => r.operation === 'createVendor')).toMatchObject({
      status: 'confirmed',
      externalRef: expect.any(String),
    });
  });

  it('unavailable while reading is retried; nothing is written until the ERP answers', async () => {
    await scripted();
    const id = await validated('S01');
    script.fail('findPurchaseInvoice', 'unavailable');
    await h.runner.drain();
    expect(await h.state(id)).toBe('COMMITTING');
    expect(await commitJob(id)).toMatchObject({ status: 'queued', attempts: 1 });
    await runDueRetries();
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
  });

  it('an ERP that stays unreachable before anything was sent fails visibly and safely', async () => {
    await scripted();
    const id = await validated('S01');
    script.fail('recordPurchaseInvoice', 'unavailable', 100);
    await h.runner.drain();
    for (let i = 0; i < 6; i++) await runDueRetries();
    expect(await h.state(id)).toBe('FAILED');
    expect(await ours(id)).toHaveLength(0);
    expect((await events(id)).filter((e) => e === 'erp.unavailable')).toHaveLength(1);
    const row = await h.veyra.invoiceRow(h.veyra.db, id);
    expect(row.failureReason).toContain("couldn't reach the business system");
    expect(await visible(id)).not.toMatch(SECRETS);
  });

  for (const fault of ['authentication_failed', 'validation', 'configuration_error'] as const) {
    it(`${fault} is not retried: FAILED at once, with a safe reason and no secrets`, async () => {
      await scripted();
      const id = await validated('S01');
      script.fail('recordPurchaseInvoice', fault);
      await h.runner.drain();
      expect(await h.state(id)).toBe('FAILED');
      expect(await commitJob(id)).toMatchObject({ status: 'failed', attempts: 1 });
      expect(await ledger(id)).toMatchObject([{ status: 'failed' }]);
      expect(await ours(id)).toHaveLength(0);
      const shown = await visible(id);
      expect(shown).not.toMatch(SECRETS);
      expect(shown).not.toMatch(/Ready for payment/);
    });
  }

  it('an unsupported operation fails with UNSUPPORTED; Veyra never falls back', async () => {
    await scripted({ capabilities: ERP_CAPABILITIES.filter((c) => c !== 'goods_receipt.create') });
    const id = await h.upload('S03');
    await h.answer(id, 'CA_GRN', 'confirm', {
      grnDate: '2026-09-17',
      lines: [{ poLineNo: 1, received: '40', accepted: '40' }],
    });
    expect(await h.state(id)).toBe('FAILED');
    // Rejected at the boundary: the call never reached the connector.
    expect(script.calls.map((c) => c.operation)).not.toContain('createGrn');
    expect((await h.veyra.invoiceRow(h.veyra.db, id)).failureReason).toMatch(/does not support/);
    expect(await h.erp.listGrns()).not.toContainEqual(
      expect.objectContaining({ sourceInvoiceId: id }),
    );
    expect(await ours(id)).toHaveLength(0);
  });
});

describe('ERP boundary: GET /api/v1/erp/connection', () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
    rmSync(dir, { recursive: true, force: true });
  });
  const open = async (wrapErp?: (erp: ErpConnector) => ErpConnector) => {
    dir = mkdtempSync(join(tmpdir(), 'veyra-conn-'));
    app = await createTestApp({
      dataDir: dir,
      demo: true,
      allowFixtureExtractor: true,
      nodeEnv: 'test',
      clock: () => DEMO_NOW,
      ...(wrapErp ? { wrapErp } : {}),
    });
    return app;
  };

  it('describes the connected business system and what it can do, read-only, no secrets', async () => {
    const a = await open();
    const res = await a.server.inject({ method: 'GET', url: '/api/v1/erp/connection' });
    expect(res.statusCode).toBe(200);
    const body = ApiErpSchema.connection.parse(res.json());
    expect(body).toMatchObject({
      type: 'fake-erp',
      displayName: 'Fake ERP',
      status: 'CONNECTED',
      company: { name: 'Veyra Demo Industries Pvt Ltd', identifier: '29AAACS1111A1Z6' },
    });
    expect(body.capabilities.find((c) => c.key === 'purchase_invoice.create')).toEqual({
      key: 'purchase_invoice.create',
      label: 'Record purchase invoices',
      supported: true,
    });
    expect(body.capabilities.find((c) => c.key === 'vendor.one_time')?.supported).toBe(false);
    expect(res.body).not.toMatch(/filename|\.db\b|password|token|secret|apiKey|credential|host/i);
    for (const method of ['POST', 'PUT', 'DELETE'] as const)
      expect((await a.server.inject({ method, url: '/api/v1/erp/connection' })).statusCode).toBe(
        404,
      );
  });

  it('reports a typed status when the ERP is not reachable, without the underlying error', async () => {
    let s: ErpScript | undefined;
    const a = await open((erp) => {
      const w = scriptedConnector(erp);
      s = w.script;
      return w.connector;
    });
    s?.connection('AUTHENTICATION_FAILED');
    const res = await a.server.inject({ method: 'GET', url: '/api/v1/erp/connection' });
    expect(res.json()).toMatchObject({ status: 'AUTHENTICATION_FAILED', company: null });
    s?.connection('UNAVAILABLE');
    const r2 = await a.server.inject({ method: 'GET', url: '/api/v1/erp/connection' });
    expect(r2.json()).toMatchObject({ status: 'UNAVAILABLE' });
    expect(r2.body).not.toMatch(SECRETS);
  });

  it('ERP failures on other endpoints return a safe code and message only', async () => {
    let s: ErpScript | undefined;
    const a = await open((erp) => {
      const w = scriptedConnector(erp);
      s = w.script;
      return w.connector;
    });
    s?.fail('listVendors', 'unavailable');
    const r1 = await a.server.inject({ method: 'GET', url: '/api/v1/erp/vendors' });
    expect(r1.statusCode).toBe(503);
    expect(r1.body).not.toMatch(SECRETS);
    s?.fail('listVendors', 'authentication_failed');
    const r2 = await a.server.inject({ method: 'GET', url: '/api/v1/erp/vendors' });
    expect(r2.json()).toMatchObject({ error: { code: 'ERP_AUTHENTICATION_FAILED' } });
    expect(r2.body).not.toMatch(SECRETS);
  });
});
