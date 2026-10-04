import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { renderScenario, scenarioById } from '@veyra/extractor';
import * as t from '../db/schema';
import { createTestApp } from '../test/app';
import { testSession, type TestSession } from '../test/auth';
import { DEMO_NOW } from '../test/harness';
import { costOf, NO_PRICING, stagesOf } from './control-centre';

/**
 * The Owner Control Centre: platform-admin only, every change audited, usage counted once per
 * reading, costs only from rates the owner sets. Real PostgreSQL; all data made up.
 */
type App = Awaited<ReturnType<typeof createTestApp>>;
let app: App | undefined;
let dir = '';
afterEach(async () => {
  await app?.close(0);
  app = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function open() {
  dir = mkdtempSync(join(tmpdir(), 'veyra-centre-'));
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => new Date(DEMO_NOW),
  });
  const operator = await testSession(app, { role: 'VEYRA_ADMIN' });
  return { a: app, operator, org: app.veyra.organizationId };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
const call = (a: App, s: TestSession, method: Method, url: string, payload?: unknown) =>
  a.anonymous({
    method,
    url: `/api/v1/ops/centre${url}`,
    headers: s.headers,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

function multipart(filename: string, bytes: Uint8Array) {
  const boundary = '----veyra-centre';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
async function upload(a: App, filename: string, bytes: Uint8Array): Promise<string> {
  const body = multipart(filename, bytes);
  const res = await a.anonymous({
    method: 'POST',
    url: '/api/v1/documents',
    payload: body.payload,
    headers: { ...body.headers, ...a.session.headers },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { invoiceId: string }).invoiceId;
}
const scenario = (a: App, id: string) => {
  const s = scenarioById(id);
  if (!s) throw new Error(id);
  return upload(a, s.file, renderScenario(s));
};
/** Accepted as a PDF, then unreadable: fails visibly at extraction. */
const DAMAGED = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Garbage >>\ntrailer\n%%EOF\n');

const events = (a: App) => a.veyra.db.select().from(t.commercialEvents);

describe('Control Centre access', () => {
  it('every Control Centre route is platform-admin only, enforced by the server', async () => {
    const { a, operator, org } = await open();
    const routes = a.server.routeAccess.filter((r) => r.url.startsWith('/api/v1/ops/centre/'));
    expect(routes.length).toBeGreaterThanOrEqual(15);
    expect(routes.every((r) => r.access === 'ops.view' || r.access === 'ops.manage')).toBe(true);
    expect(
      routes
        .filter((r) => r.method !== 'GET' && r.method !== 'HEAD')
        .every((r) => r.access === 'ops.manage'),
    ).toBe(true);
    const customers = [
      a.session,
      await testSession(a, { role: 'ADMIN' }),
      await testSession(a, { role: 'FINANCE' }),
      await testSession(a, { role: 'REVIEWER' }),
    ];
    const anyBody = {
      reason: 'x',
      suspended: true,
      active: false,
      pricing: NO_PRICING,
      priceMonthlyPaise: 1,
      confidenceMinBp: 9000,
    };
    for (const r of routes) {
      const url = r.url.replace(':id', org).replace(':key', 'STARTER');
      for (const s of [...customers, null]) {
        const res = await a.anonymous({
          method: r.method as Method,
          url,
          headers: s ? s.headers : {},
          ...(r.method === 'GET' || r.method === 'HEAD' ? {} : { payload: anyBody }),
        });
        expect(res.statusCode, `${r.method} ${url}`).toBe(s ? 403 : 401);
        expect(res.body).not.toMatch(/passwordHash|password_hash|apiKey/);
      }
    }
    expect(await events(a)).toEqual([]);
    for (const url of ['/overview', '/customers', '/users', '/processing', '/cost', '/config'])
      expect((await call(a, operator, 'GET', url)).statusCode, url).toBe(200);
  });

  it('the user list never carries passwords, hashes, sessions or tokens', async () => {
    const { a, operator } = await open();
    const res = await call(a, operator, 'GET', '/users');
    expect(res.statusCode).toBe(200);
    const users = res.json() as Record<string, unknown>[];
    expect(users.length).toBeGreaterThan(1);
    for (const u of users)
      expect(Object.keys(u).sort()).toEqual(
        [
          'active',
          'createdAt',
          'email',
          'id',
          'lastLoginAt',
          'lastSeenAt',
          'name',
          'organization',
          'organizationId',
          'platform',
          'role',
        ].sort(),
      );
    expect(res.body).not.toMatch(/argon|token|csrf/i);
  });
});

describe('customers: suspend and reactivate', () => {
  it('a suspended customer cannot use Veyrafy; reactivation restores the previous status; both audited', async () => {
    const { a, operator, org } = await open();
    expect((await a.server.inject({ url: '/api/v1/invoices' })).statusCode).toBe(200);

    const noReason = await call(a, operator, 'POST', `/customers/${org}/suspension`, {
      suspended: true,
      reason: ' ',
    });
    expect(noReason.statusCode).toBe(422);

    const s = await call(a, operator, 'POST', `/customers/${org}/suspension`, {
      suspended: true,
      reason: 'Invoice unpaid for 60 days',
    });
    expect(s.statusCode).toBe(200);
    expect((s.json() as { summary: { status: string } }).summary.status).toBe('suspended');

    // Immediately (no cache delay): customer routes refused, signing out still works.
    const refused = await a.server.inject({ url: '/api/v1/invoices' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'ACCOUNT_SUSPENDED' } });
    expect((await scenarioUploadStatus(a)).statusCode).toBe(403);
    expect((await call(a, operator, 'GET', '/overview')).statusCode).toBe(200);

    // Suspending twice is refused; a plan change cannot be used to unsuspend.
    expect(
      (
        await call(a, operator, 'POST', `/customers/${org}/suspension`, {
          suspended: true,
          reason: 'again',
        })
      ).statusCode,
    ).toBe(409);
    const viaPlan = await a.anonymous({
      method: 'POST',
      url: `/api/v1/ops/organizations/${org}/plan`,
      headers: operator.headers,
      payload: { planKey: 'STARTER', reason: 'x', commercialStatus: 'suspended' },
    });
    expect(viaPlan.statusCode).toBe(422);

    const r = await call(a, operator, 'POST', `/customers/${org}/suspension`, {
      suspended: false,
      reason: 'Paid',
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { summary: { status: string } }).summary.status).toBe('active');
    expect((await a.server.inject({ url: '/api/v1/invoices' })).statusCode).toBe(200);

    const trail = (await events(a)).map((e) => ({
      event: e.event,
      old: e.oldValueJson,
      new: e.newValueJson,
      reason: e.reason,
      actor: e.actorUserId,
    }));
    expect(trail).toEqual([
      {
        event: 'organization.suspended',
        old: '{"status":"active"}',
        new: '{"status":"suspended"}',
        reason: 'Invoice unpaid for 60 days',
        actor: operator.userId,
      },
      {
        event: 'organization.reactivated',
        old: '{"status":"suspended"}',
        new: '{"status":"active"}',
        reason: 'Paid',
        actor: operator.userId,
      },
    ]);
  });
});
const scenarioUploadStatus = (a: App) => {
  const s = scenarioById('S01');
  if (!s) throw new Error('S01');
  const body = multipart(s.file, renderScenario(s));
  return a.anonymous({
    method: 'POST',
    url: '/api/v1/documents',
    payload: body.payload,
    headers: { ...body.headers, ...a.session.headers },
  });
};

describe('users: enable and disable', () => {
  it('disabling ends the user’s sessions at once, is audited twice (security + platform), and is reversible', async () => {
    const { a, operator, org } = await open();
    const finance = await testSession(a, { role: 'FINANCE' });
    expect(
      (await a.anonymous({ url: '/api/v1/invoices', headers: finance.headers })).statusCode,
    ).toBe(200);
    const off = await call(a, operator, 'POST', `/users/${finance.userId}/active`, {
      active: false,
      reason: 'Left the company',
    });
    expect(off.statusCode).toBe(200);
    expect(
      (await a.anonymous({ url: '/api/v1/invoices', headers: finance.headers })).statusCode,
    ).toBe(401);
    const sec = await a.veyra.db
      .select()
      .from(t.securityEvents)
      .where(eq(t.securityEvents.subjectUserId, finance.userId));
    expect(sec.map((e) => e.event)).toContain('user.disabled');

    const on = await call(a, operator, 'POST', `/users/${finance.userId}/active`, {
      active: true,
      reason: 'Rejoined',
    });
    expect(on.statusCode).toBe(200);
    const list = (
      await call(a, operator, 'GET', `/users?organizationId=${org}&active=true`)
    ).json() as {
      id: string;
    }[];
    expect(list.map((u) => u.id)).toContain(finance.userId);

    expect((await events(a)).map((e) => [e.event, e.subject, e.reason])).toEqual([
      ['user.disabled', `user:${finance.userId}`, 'Left the company'],
      ['user.enabled', `user:${finance.userId}`, 'Rejoined'],
    ]);
  });

  it('never yourself, never a platform account, never the customer’s last administrator', async () => {
    const { a, operator } = await open();
    const other = await testSession(a, { role: 'VEYRA_ADMIN' });
    const self = await call(a, operator, 'POST', `/users/${operator.userId}/active`, {
      active: false,
      reason: 'x',
    });
    expect(self.statusCode).toBe(409);
    const platform = await call(a, operator, 'POST', `/users/${other.userId}/active`, {
      active: false,
      reason: 'x',
    });
    expect(platform.statusCode).toBe(409);
    // The demo's designated user is the customer's only administrator.
    const last = await call(a, operator, 'POST', `/users/${a.session.userId}/active`, {
      active: false,
      reason: 'x',
    });
    expect(last.statusCode).toBe(409);
    expect(await events(a)).toEqual([]);
  });
});

describe('invoice processing and retry', () => {
  it('lists invoices with their phases; a failed one is retried only once safe, and audited', async () => {
    const { a, operator } = await open();
    const ok = await scenario(a, 'S01');
    const bad = await upload(a, 'scan.pdf', DAMAGED);
    await a.runner.drain();

    const res = await call(a, operator, 'GET', '/processing');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      invoices: {
        id: string;
        state: string;
        extraction: string;
        failed: boolean;
        retryable: boolean;
        retryCount: number;
      }[];
      failures: { stage: string; count: number }[];
    };
    const failed = body.invoices.find((i) => i.id === bad);
    expect(failed).toMatchObject({
      state: 'FAILED',
      extraction: 'failed',
      failed: true,
      retryable: true,
      retryCount: 0,
    });
    expect(body.invoices.find((i) => i.id === ok)?.failed).toBe(false);
    expect(body.failures).toEqual([expect.objectContaining({ stage: 'EXTRACTING', count: 1 })]);
    expect(res.body).not.toMatch(/detailJson|rawJson|storagePath/);

    // Only failed invoices can be retried; a reason is required.
    expect(
      (await call(a, operator, 'POST', `/processing/${ok}/retry`, { reason: 'x' })).statusCode,
    ).toBe(409);
    expect(
      (await call(a, operator, 'POST', `/processing/${bad}/retry`, { reason: '' })).statusCode,
    ).toBe(422);
    const retried = await call(a, operator, 'POST', `/processing/${bad}/retry`, {
      reason: 'Reader updated',
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ from: 'FAILED', to: 'EXTRACTING' });
    await a.runner.drain();

    const detail = (await call(a, operator, 'GET', `/processing/${bad}`)).json() as {
      summary: { retryCount: number; state: string };
      events: Record<string, unknown>[];
    };
    expect(detail.summary).toMatchObject({ state: 'FAILED', retryCount: 1 });
    expect(Object.keys(detail.events[0] ?? {}).sort()).toEqual(
      ['actorType', 'at', 'event', 'fromState', 'toState'].sort(),
    );
    expect((await events(a)).map((e) => [e.event, e.subject, e.newValueJson])).toEqual([
      ['processing.retried', `invoice:${bad}`, '{"state":"EXTRACTING"}'],
    ]);
  });
});

describe('usage and cost', () => {
  it('one usage row per reading, never doubled by a job retry; no rate, no cost', async () => {
    const { a, operator } = await open();
    const id = await scenario(a, 'S01');
    await a.runner.drain();
    await a.runner.drain();
    const rows = await a.veyra.db
      .select()
      .from(t.processingUsage)
      .where(eq(t.processingUsage.invoiceId, id));
    expect(rows).toHaveLength(1);
    const extractions = await a.veyra.db
      .select()
      .from(t.extractions)
      .where(eq(t.extractions.invoiceId, id));
    expect(rows[0]?.extractionId).toBe(extractions[0]?.id);
    expect(rows[0]).toMatchObject({ pages: 1, aiCalls: 0 });
    expect(rows[0]?.documentBytes).toBeGreaterThan(0);

    // Make the reading an AI reading (as a Gemini reading records it) to price it.
    await a.veyra.db
      .update(t.processingUsage)
      .set({ aiModel: 'model-a', aiCalls: 2, aiInputTokens: 2_000_000, aiOutputTokens: 500_000 })
      .where(eq(t.processingUsage.invoiceId, id));
    type Cost = {
      totals: {
        invoices: number;
        aiPaise: number | null;
        totalPaise: number | null;
        unpricedReadings: number;
        perInvoicePaise: number | null;
        aiInputTokens: number;
      };
      geminiUsagePercent: number;
      documentAi: { used: boolean; pages: number };
      byMethod: { key: string }[];
      byModel: { key: string; aiPaise: number | null }[];
      ledger: { invoiceId: string; aiPaise: number | null }[];
    };
    const before = (await call(a, operator, 'GET', '/cost')).json() as Cost;
    expect(before.totals).toMatchObject({
      invoices: 1,
      aiPaise: null,
      totalPaise: null,
      unpricedReadings: 1,
      aiInputTokens: 2_000_000,
    });
    expect(before.geminiUsagePercent).toBe(100);
    expect(before.documentAi).toMatchObject({ used: false, pages: 0 });

    const set = await call(a, operator, 'PUT', '/pricing', {
      reason: 'Provider price list, October',
      pricing: {
        aiInputPer1MPaise: 2_500, // ₹25 per million input tokens (made up)
        aiOutputPer1MPaise: 20_000,
        models: { 'model-a': { inputPer1MPaise: 5_000, outputPer1MPaise: null } },
        infrastructurePerInvoicePaise: 150,
      },
    });
    expect(set.statusCode).toBe(200);
    const after = (await call(a, operator, 'GET', '/cost')).json() as Cost;
    // model-a input at its own rate (2M × ₹50/M = ₹100), output at the default (0.5M × ₹200/M).
    expect(after.totals).toMatchObject({
      aiPaise: 10_000 + 10_000,
      totalPaise: 20_000 + 150,
      perInvoicePaise: 20_150,
      unpricedReadings: 0,
    });
    expect(after.byModel).toEqual([expect.objectContaining({ key: 'model-a', aiPaise: 20_000 })]);
    expect(after.ledger[0]).toMatchObject({ invoiceId: id, aiPaise: 20_000 });

    const overview = (await call(a, operator, 'GET', '/overview')).json() as {
      cost: { aiPaise: number; perInvoicePaise: number };
      invoicesThisMonth: number;
    };
    expect(overview.cost).toMatchObject({ aiPaise: 20_000, perInvoicePaise: 20_150 });
    expect(overview.invoicesThisMonth).toBe(1);

    const trail = await events(a);
    expect(trail.map((e) => [e.event, e.subject])).toEqual([
      ['config.changed', 'setting:platform.pricing'],
    ]);
    expect(JSON.parse(trail[0]?.oldValueJson ?? '{}')).toEqual(NO_PRICING);

    // Rates are validated: no negative or fractional paise.
    expect(
      (
        await call(a, operator, 'PUT', '/pricing', {
          reason: 'x',
          pricing: { ...NO_PRICING, aiInputPer1MPaise: -1 },
        })
      ).statusCode,
    ).toBe(422);
  });

  it('cost arithmetic: a missing rate is "not set", never zero', () => {
    const u = { aiModel: 'm', aiCalls: 1, aiInputTokens: 1_000_000, aiOutputTokens: 0 };
    expect(costOf(u, NO_PRICING)).toEqual({ aiPaise: null });
    expect(costOf({ ...u, aiCalls: 0, aiInputTokens: 0 }, NO_PRICING)).toEqual({ aiPaise: 0 });
    expect(costOf(u, { ...NO_PRICING, aiInputPer1MPaise: 333 })).toEqual({ aiPaise: 333 });
  });

  it('phases follow the invoice state', () => {
    expect(stagesOf('UPLOADED', null)).toEqual({
      extraction: 'waiting',
      verification: 'waiting',
      resolution: 'waiting',
    });
    expect(stagesOf('NEEDS_INPUT', null)).toEqual({
      extraction: 'done',
      verification: 'done',
      resolution: 'needs_input',
    });
    expect(stagesOf('FAILED', 'VALIDATING')).toMatchObject({
      extraction: 'done',
      verification: 'failed',
    });
    expect(stagesOf('VERIFIED_PENDING_PAYMENT', null).resolution).toBe('done');
  });
});

describe('plans, configuration and the audit log', () => {
  it('plan price feeds MRR; the confidence threshold is bounded; every change is in the audit log', async () => {
    const { a, operator, org } = await open();
    let o = (await call(a, operator, 'GET', '/overview')).json() as {
      mrr: { status: string; paise: number | null };
    };
    expect(o.mrr).toEqual({ status: 'price_not_set', paise: null });

    const price = await call(a, operator, 'PATCH', '/plans/ENTERPRISE/price', {
      priceMonthlyPaise: 4_999_900,
      reason: 'List price',
    });
    expect(price.statusCode).toBe(200);
    o = (await call(a, operator, 'GET', '/overview')).json() as typeof o;
    expect(o.mrr).toEqual({ status: 'ok', paise: 4_999_900 });

    const bad = await call(a, operator, 'PATCH', '/config/confidence', {
      confidenceMinBp: 5000,
      reason: 'x',
    });
    expect(bad.statusCode).toBe(422);
    const conf = await call(a, operator, 'PATCH', '/config/confidence', {
      confidenceMinBp: 9200,
      reason: 'Fewer guesses',
    });
    expect(conf.statusCode).toBe(200);
    expect((conf.json() as { confidenceMinBp: number }).confidenceMinBp).toBe(9200);
    expect((await a.veyra.settings()).confidenceMinBp).toBe(9200);

    const cfg = (await call(a, operator, 'GET', '/config')).json() as Record<string, unknown>;
    expect(JSON.stringify(cfg)).not.toMatch(/key-|apiKey|password|DATABASE_URL/i);
    expect(cfg).toMatchObject({ email: { configured: false } });

    const log = (await call(a, operator, 'GET', '/audit')).json() as {
      event: string;
      subject: string | null;
      planKey: string | null;
      oldValue: unknown;
      newValue: unknown;
      actor: string | null;
    }[];
    expect(log.map((e) => e.event)).toEqual(['config.changed', 'plan.price_changed']);
    expect(log[0]).toMatchObject({
      subject: 'setting:confidenceMinBp',
      oldValue: 9000,
      newValue: 9200,
      actor: 'Test veyra_admin',
    });
    expect(log[1]).toMatchObject({ planKey: 'ENTERPRISE', oldValue: null, newValue: 4_999_900 });
    const filtered = (
      await call(a, operator, 'GET', '/audit?event=plan.price_changed')
    ).json() as unknown[];
    expect(filtered).toHaveLength(1);
    void org;
  });
});
