import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ErpConnector } from '@veyra/erp-connector';
import { renderScenario, scenarioById } from '@veyra/extractor';
import {
  ApiCapabilitiesSchema,
  ApiOpsCommercialSchema,
  type EntitlementValue,
} from '@veyra/shared';
import * as t from '../db/schema';
import { createTestApp } from '../test/app';
import { testSession, type TestSession } from '../test/auth';
import { DEMO_NOW } from '../test/harness';

/**
 * Phase 8A: commercial entitlements and Veyra Operations. PLAN → ENTITLEMENTS → ORGANIZATION →
 * OVERRIDES → EFFECTIVE CAPABILITY → SERVER-SIDE ENFORCEMENT, against real PostgreSQL.
 */
type App = Awaited<ReturnType<typeof createTestApp>>;
let app: App | undefined;
let dir = '';
afterEach(async () => {
  await app?.close(0);
  app = undefined;
  rmSync(dir, { recursive: true, force: true });
});

let now = new Date(DEMO_NOW);
async function open(opts: { wrapErp?: (erp: ErpConnector) => ErpConnector } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'veyra-commercial-'));
  now = new Date(DEMO_NOW);
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => now,
    ...(opts.wrapErp ? { wrapErp: opts.wrapErp } : {}),
  });
  const operator = await testSession(app, { role: 'VEYRA_ADMIN' });
  return { a: app, operator, org: app.veyra.organizationId };
}

const as = (s: TestSession) => ({ headers: s.headers });

async function call(
  a: App,
  s: TestSession,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
) {
  return a.anonymous({
    method,
    url,
    ...as(s),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

const setOverride = (
  a: App,
  s: TestSession,
  org: string,
  capability: string,
  value: EntitlementValue,
  extra: { reason?: string; expiresAt?: string } = {},
) =>
  call(a, s, 'POST', `/api/v1/ops/organizations/${org}/overrides/${capability}`, {
    value,
    reason: extra.reason ?? 'Pilot',
    ...(extra.expiresAt ? { expiresAt: extra.expiresAt } : {}),
  });

const assignPlan = (a: App, s: TestSession, org: string, planKey: string) =>
  call(a, s, 'POST', `/api/v1/ops/organizations/${org}/plan`, { planKey, reason: 'Contract' });

async function commercial(a: App, s: TestSession, org: string) {
  const res = await call(a, s, 'GET', `/api/v1/ops/organizations/${org}/commercial`);
  expect(res.statusCode).toBe(200);
  return ApiOpsCommercialSchema.parse(res.json());
}
const row = (c: Awaited<ReturnType<typeof commercial>>, key: string) =>
  c.entitlements.find((e) => e.capability === key);

function multipart(files: { filename: string; bytes: Uint8Array; type?: string }[]) {
  const boundary = '----veyra-commercial';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      ...files.flatMap((f) => [
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: ${f.type ?? 'application/pdf'}\r\n\r\n`,
        ),
        Buffer.from(f.bytes),
        Buffer.from('\r\n'),
      ]),
      Buffer.from(`--${boundary}--\r\n`),
    ]),
  };
}
const upload = (a: App, id: string, session?: TestSession) => {
  const s = scenarioById(id);
  if (!s) throw new Error(id);
  const body = multipart([{ filename: s.file, bytes: renderScenario(s) }]);
  return a.anonymous({
    method: 'POST',
    url: '/api/v1/documents',
    payload: body.payload,
    headers: { ...body.headers, ...(session ?? a.session).headers },
  });
};
const VENDORS_CSV = readFileSync(
  new URL('../../../../fixtures/imports/Demo-Vendors.csv', import.meta.url),
);
const importCheck = (a: App) =>
  a.server.inject({
    method: 'POST',
    url: '/api/v1/imports',
    ...multipart([{ filename: 'Demo-Vendors.csv', bytes: VENDORS_CSV, type: 'text/csv' }]),
  });

describe('entitlement resolution: plan → override → effective', () => {
  it('an existing organization starts on ENTERPRISE: everything on, no quotas, from the plan', async () => {
    const { a, operator, org } = await open();
    const c = await commercial(a, operator, org);
    expect(c.organization).toMatchObject({
      plan: { key: 'ENTERPRISE' },
      billing: 'not_configured',
    });
    expect(row(c, 'erp.business_record_import')).toMatchObject({
      plan: { enabled: true },
      override: null,
      effective: { enabled: true },
      source: 'plan',
    });
    expect(row(c, 'invoice.monthly_limit')).toMatchObject({ effective: { limit: null } });
  });

  it('plan OFF → unavailable; plan ON → available; the operator sees why', async () => {
    const { a, operator, org } = await open();
    expect((await assignPlan(a, operator, org, 'STARTER')).statusCode).toBe(200);
    let c = await commercial(a, operator, org);
    expect(row(c, 'reports.exports')).toMatchObject({
      plan: { enabled: false },
      effective: { enabled: false },
      source: 'plan',
    });
    expect(row(c, 'invoice.monthly_limit')).toMatchObject({ effective: { limit: 500 }, used: 0 });
    expect(await a.veyra.entitlements.can(org, 'reports.exports')).toBe(false);
    expect((await assignPlan(a, operator, org, 'BUSINESS')).statusCode).toBe(200);
    c = await commercial(a, operator, org);
    expect(row(c, 'reports.exports')).toMatchObject({
      effective: { enabled: true },
      source: 'plan',
    });
  });

  it('an override ON enables a feature the plan lacks; OFF disables one it has; the plan is untouched', async () => {
    const { a, operator, org } = await open();
    await assignPlan(a, operator, org, 'STARTER');
    expect(
      (await setOverride(a, operator, org, 'erp.business_record_import', { enabled: true }))
        .statusCode,
    ).toBe(200);
    let c = await commercial(a, operator, org);
    expect(row(c, 'erp.business_record_import')).toMatchObject({
      plan: { enabled: false },
      override: { value: { enabled: true }, reason: 'Pilot', expired: false },
      effective: { enabled: true },
      source: 'override',
    });
    await assignPlan(a, operator, org, 'BUSINESS');
    await setOverride(a, operator, org, 'reports.exports', { enabled: false });
    c = await commercial(a, operator, org);
    expect(row(c, 'reports.exports')).toMatchObject({
      plan: { enabled: true },
      effective: { enabled: false },
      source: 'override',
    });
    // The plan itself did not change.
    const plans = (await call(a, operator, 'GET', '/api/v1/ops/plans')).json<
      { key: string; entitlements: { capability: string; value: unknown }[] }[]
    >();
    expect(
      plans
        .find((p) => p.key === 'BUSINESS')
        ?.entitlements.find((e) => e.capability === 'reports.exports')?.value,
    ).toEqual({ enabled: true });
  });

  it('a temporary override is effective before its expiry and falls back to the plan after, with no clean-up', async () => {
    const { a, operator, org } = await open();
    await assignPlan(a, operator, org, 'STARTER');
    const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    await setOverride(a, operator, org, 'reports.exports', { enabled: true }, { expiresAt });
    expect(await a.veyra.entitlements.can(org, 'reports.exports')).toBe(true);
    now = new Date(now.getTime() + 59 * 60_000);
    expect(await a.veyra.entitlements.can(org, 'reports.exports')).toBe(true);
    now = new Date(now.getTime() + 2 * 60_000); // past the expiry; nothing else happens
    expect(await a.veyra.entitlements.can(org, 'reports.exports')).toBe(false);
    // A fresh session: the clock moved past the first one's idle limit.
    const again = await testSession(a, { role: 'VEYRA_ADMIN' });
    const c = await commercial(a, again, org);
    expect(row(c, 'reports.exports')).toMatchObject({
      override: { expired: true },
      effective: { enabled: false },
      source: 'plan',
    });
    // An expiry in the past is refused.
    const past = await setOverride(
      a,
      again,
      org,
      'reports.exports',
      { enabled: true },
      {
        expiresAt: new Date(now.getTime() - 1000).toISOString(),
      },
    );
    expect(past.statusCode).toBe(422);
  });

  it('removing an override returns to the plan; no entitlement at all means unavailable', async () => {
    const { a, operator, org } = await open();
    await assignPlan(a, operator, org, 'STARTER');
    await setOverride(a, operator, org, 'invoice.monthly_limit', { limit: 5000 });
    expect(await a.veyra.entitlements.limit(org, 'invoice.monthly_limit')).toBe(5000);
    const removed = await call(
      a,
      operator,
      'POST',
      `/api/v1/ops/organizations/${org}/overrides/invoice.monthly_limit/remove`,
      { reason: 'Negotiation ended' },
    );
    expect(removed.statusCode).toBe(200);
    expect(await a.veyra.entitlements.limit(org, 'invoice.monthly_limit')).toBe(500);
    // A plan without a row for a capability: not included.
    const ts = DEMO_NOW.toISOString();
    await a.veyra.db.insert(t.plans).values({
      key: 'EMPTY',
      name: 'Empty',
      status: 'active',
      description: 'x',
      createdAt: ts,
      updatedAt: ts,
    });
    await assignPlan(a, operator, org, 'EMPTY');
    const c = await commercial(a, operator, org);
    expect(row(c, 'reports.exports')).toMatchObject({
      plan: null,
      source: 'none',
      effective: { enabled: false },
    });
    expect(row(c, 'users.max')).toMatchObject({ effective: { limit: 0 }, source: 'none' });
  });

  it('values must match the capability type; unknown capabilities and missing reasons are refused', async () => {
    const { a, operator, org } = await open();
    for (const [capability, value, reason] of [
      ['reports.exports', { limit: 3 }, 'x'],
      ['invoice.monthly_limit', { enabled: true }, 'x'],
      ['invoice.monthly_limit', { limit: -1 }, 'x'],
      ['everything', { enabled: true }, 'x'],
      ['reports.exports', { enabled: true }, '   '],
    ] as const) {
      const res = await setOverride(a, operator, org, capability, value as EntitlementValue, {
        reason,
      });
      expect(res.statusCode, `${capability} ${JSON.stringify(value)}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
    expect(await a.veyra.db.select().from(t.entitlementOverrides)).toEqual([]);
    expect(await a.veyra.db.select().from(t.commercialEvents)).toEqual([]);
  });
});

describe('limits are enforced by the server', () => {
  it('monthly invoices: under and at the limit accepted, over refused with a business message', async () => {
    const { a, operator, org } = await open();
    await setOverride(a, operator, org, 'invoice.monthly_limit', { limit: 2 });
    expect((await upload(a, 'S01')).statusCode).toBe(201); // 1 of 2: under
    expect((await upload(a, 'S02')).statusCode).toBe(201); // 2 of 2: at
    const over = await upload(a, 'S03');
    expect(over.statusCode).toBe(403);
    expect(over.json()).toMatchObject({
      error: { code: 'LIMIT_REACHED', message: 'Monthly invoice processing limit reached.' },
    });
    expect(over.body).not.toMatch(/STARTER|ENTERPRISE|override|plan_entitlements/i);
    expect(await a.veyra.db.select().from(t.documents)).toHaveLength(2); // nothing processed beyond
    // Next month counts afresh.
    now = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2));
    expect((await upload(a, 'S03', await testSession(a))).statusCode).toBe(201);
  });

  it('parallel uploads at the limit cannot pass it together', async () => {
    const { a, operator, org } = await open();
    await setOverride(a, operator, org, 'invoice.monthly_limit', { limit: 3 });
    const results = await Promise.all(
      ['S01', 'S02', 'S03', 'S04', 'S05'].map((id) => upload(a, id)),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 403)).toHaveLength(2);
    expect(await a.veyra.db.select().from(t.documents)).toHaveLength(3);
  });

  it('storage and active users are limits too', async () => {
    const { a, operator, org } = await open();
    await setOverride(a, operator, org, 'storage.max_bytes', { limit: 1000 });
    const res = await upload(a, 'S01');
    expect(res.json()).toMatchObject({
      error: { code: 'LIMIT_REACHED', message: 'Document storage limit reached.' },
    });
    const active = (
      await a.veyra.db.select().from(t.users).where(eq(t.users.organizationId, org))
    ).filter((u) => u.active).length;
    await setOverride(a, operator, org, 'users.max', { limit: active });
    const created = await a.server.inject({
      method: 'POST',
      url: '/api/v1/users',
      payload: {
        email: 'new@toit.example',
        name: 'New',
        role: 'FINANCE',
        password: 'a long enough password 1',
      },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json()).toMatchObject({ error: { code: 'LIMIT_REACHED' } });
    await setOverride(a, operator, org, 'users.max', { limit: active + 1 });
    const ok = await a.server.inject({
      method: 'POST',
      url: '/api/v1/users',
      payload: {
        email: 'new@toit.example',
        name: 'New',
        role: 'FINANCE',
        password: 'a long enough password 1',
      },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('boolean capabilities are enforced by the server', () => {
  it('exports: refused when not entitled, allowed when entitled (the API, not just the UI)', async () => {
    const { a, operator, org } = await open();
    await setOverride(a, operator, org, 'reports.exports', { enabled: false });
    const refused = await a.server.inject({ method: 'GET', url: '/api/v1/exports/invoices.xlsx' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: { code: 'NOT_ENTITLED', message: 'This is not included in your Veyrafy plan.' },
    });
    await setOverride(a, operator, org, 'reports.exports', { enabled: true });
    expect(
      (await a.server.inject({ method: 'GET', url: '/api/v1/exports/invoices.xlsx' })).statusCode,
    ).toBe(200);
  });

  it('ERP imports need BOTH the commercial entitlement and the ERP capability', async () => {
    // commercial ON + ERP ON → allowed
    let o = await open();
    expect((await importCheck(o.a)).statusCode).toBe(201);
    // commercial OFF + ERP ON → refused (commercial)
    await setOverride(o.a, o.operator, o.org, 'erp.business_record_import', { enabled: false });
    const off = await importCheck(o.a);
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ error: { code: 'NOT_ENTITLED' } });
    await o.a.close(0);
    app = undefined;
    // commercial ON + ERP OFF → refused (the ERP cannot do it; the entitlement does not force it)
    o = await open({
      wrapErp: (erp) =>
        new Proxy(erp, {
          get(target, prop, receiver) {
            if (prop === 'capabilities')
              return () => target.capabilities().filter((c) => c !== 'business_records.import');
            const v: unknown = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        }),
    });
    expect(await o.a.veyra.entitlements.can(o.org, 'erp.business_record_import')).toBe(true);
    const unsupported = await importCheck(o.a);
    expect(unsupported.statusCode).toBe(502);
    expect(unsupported.json()).toMatchObject({ error: { code: 'ERP_UNSUPPORTED' } });
  });

  it('the customer sees availability and usage, never plans, overrides or reasons', async () => {
    const { a, operator, org } = await open();
    await assignPlan(a, operator, org, 'STARTER');
    await setOverride(
      a,
      operator,
      org,
      'reports.exports',
      { enabled: true },
      { reason: 'Secret deal' },
    );
    await upload(a, 'S01');
    const res = await a.server.inject({ method: 'GET', url: '/api/v1/capabilities' });
    const body = ApiCapabilitiesSchema.parse(res.json());
    expect(body.capabilities.find((c) => c.key === 'reports.exports')?.available).toBe(true);
    expect(body.capabilities.find((c) => c.key === 'erp.business_record_import')?.available).toBe(
      false,
    );
    expect(body.capabilities.find((c) => c.key === 'invoice.monthly_limit')).toMatchObject({
      limit: 500,
      used: 1,
    });
    expect(res.body).not.toMatch(/STARTER|Starter|Secret deal|override|plan/);
  });
});

describe('Veyrafy Operations is for VEYRA_ADMIN only', () => {
  it('every ops route refuses customer ADMIN, FINANCE and REVIEWER; VEYRA_ADMIN reads them', async () => {
    const { a, operator, org } = await open();
    const ops = a.server.routeAccess.filter((r) => r.url.startsWith('/api/v1/ops/'));
    expect(ops.length).toBeGreaterThanOrEqual(12);
    expect(ops.every((r) => r.access === 'ops.view' || r.access === 'ops.manage')).toBe(true);
    const customers = [
      a.session, // the demo's designated user: a customer ADMIN
      await testSession(a, { role: 'ADMIN' }),
      await testSession(a, { role: 'FINANCE' }),
      await testSession(a, { role: 'REVIEWER' }),
    ];
    for (const r of ops) {
      const url = r.url
        .replace(':id', org)
        .replace(':capability', 'reports.exports')
        .replace(':key', 'STARTER');
      for (const s of customers) {
        const res = await a.anonymous({
          method: r.method as 'GET',
          url,
          headers: s.headers,
          ...(r.method === 'GET' || r.method === 'HEAD'
            ? {}
            : { payload: { value: { enabled: true }, reason: 'x', planKey: 'STARTER' } }),
        });
        expect(res.statusCode, `${r.method} ${url}`).toBe(403);
      }
      // (One invoice's processing detail needs an invoice id: covered by the Control Centre tests.)
      if (r.method === 'GET' && !r.url.endsWith('/processing/:id'))
        expect((await call(a, operator, 'GET', url)).statusCode, url).toBe(200);
    }
    // Nothing changed through a customer.
    expect(await a.veyra.db.select().from(t.commercialEvents)).toEqual([]);
  });

  it('VEYRA_ADMIN cannot use the customer application; a customer ADMIN cannot create a VEYRA_ADMIN', async () => {
    const { a, operator } = await open();
    for (const url of [
      '/api/v1/invoices',
      '/api/v1/documents',
      '/api/v1/audit',
      '/api/v1/erp/vendors',
      '/api/v1/users',
      '/api/v1/capabilities',
    ])
      expect((await call(a, operator, 'GET', url)).statusCode, url).toBe(403);
    const session = (await call(a, operator, 'GET', '/api/v1/auth/session')).json<{
      permissions: string[];
      organization: { name: string };
    }>();
    expect(session.permissions.sort()).toEqual(['ops.manage', 'ops.view']);
    expect(session.organization.name).toBe('Veyrafy Operations');
    const created = await a.server.inject({
      method: 'POST',
      url: '/api/v1/users',
      payload: {
        email: 'x@toit.example',
        name: 'X',
        role: 'VEYRA_ADMIN',
        password: 'a long enough password 1',
      },
    });
    expect(created.statusCode).toBe(422);
    // The database refuses a platform role in a customer organization, whatever the code does.
    await expect(
      a.veyra.db
        .update(t.users)
        .set({ role: 'VEYRA_ADMIN' })
        .where(eq(t.users.id, a.session.userId)),
    ).rejects.toThrow();
  });

  it('a VEYRA_ADMIN change needs the CSRF token like any other', async () => {
    const { a, operator, org } = await open();
    const res = await a.anonymous({
      method: 'POST',
      url: `/api/v1/ops/organizations/${org}/overrides/reports.exports`,
      headers: { cookie: operator.cookie },
      payload: { value: { enabled: false }, reason: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(await a.veyra.entitlements.can(org, 'reports.exports')).toBe(true);
  });
});

describe('commercial audit and cache', () => {
  it('every change is audited with organization, capability, old and new value, actor, reason, expiry', async () => {
    const { a, operator, org } = await open();
    await assignPlan(a, operator, org, 'STARTER');
    const expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
    await setOverride(
      a,
      operator,
      org,
      'invoice.monthly_limit',
      { limit: 5000 },
      { reason: 'Negotiated', expiresAt },
    );
    await call(a, operator, 'PATCH', '/api/v1/ops/plans/STARTER/entitlements/users.max', {
      value: { limit: 4 },
      reason: 'Plan revision',
    });
    const events = (await call(a, operator, 'GET', '/api/v1/ops/commercial/events')).json<
      Record<string, unknown>[]
    >();
    expect(events.map((e) => e.event)).toEqual([
      'plan.entitlement_changed',
      'override.set',
      'plan.assigned',
    ]);
    expect(events[1]).toMatchObject({
      organizationId: org,
      capability: 'invoice.monthly_limit',
      oldValue: { limit: 500 },
      newValue: { limit: 5000 },
      reason: 'Negotiated',
      expiresAt,
      actor: 'Test veyra_admin',
    });
    expect(events[2]).toMatchObject({
      oldValue: { plan: 'ENTERPRISE' },
      newValue: { plan: 'STARTER' },
    });
    expect(events[0]).toMatchObject({
      planKey: 'STARTER',
      oldValue: { limit: 3 },
      newValue: { limit: 4 },
    });
    // Overrides are revoked, never deleted: history stays.
    await setOverride(a, operator, org, 'invoice.monthly_limit', { limit: 6000 });
    const rows = await a.veyra.db.select().from(t.entitlementOverrides);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });

  it('checks are cached per organization (no query per check) and a change is visible at once', async () => {
    const { a, operator, org } = await open();
    await a.veyra.entitlements.can(org, 'reports.exports'); // warm
    const spy = vi.spyOn(a.veyra.db, 'select');
    for (let i = 0; i < 100; i++) {
      await a.veyra.entitlements.can(org, 'reports.exports');
      await a.veyra.entitlements.limit(org, 'invoice.monthly_limit');
    }
    await a.veyra.entitlements.all(org);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await setOverride(a, operator, org, 'reports.exports', { enabled: false });
    expect(await a.veyra.entitlements.can(org, 'reports.exports')).toBe(false);
    // The cache is keyed by organization: another organization's rows are never used.
    expect(await a.veyra.entitlements.can(t.PLATFORM_ORGANIZATION_ID, 'reports.exports')).toBe(
      false,
    );
  });
});
