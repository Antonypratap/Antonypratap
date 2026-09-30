import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { renderScenario, scenarioById } from '@veyra/extractor';
import { CSRF_HEADER, type Role } from '@veyra/shared';
import type { AppConfig } from '../app';
import * as t from '../db/schema';
import { Secret } from '../secret';
import { createTestApp } from '../test/app';
import { testSession, type TestSession } from '../test/auth';
import { DEMO_NOW } from '../test/harness';
import { createLogger, redact, safeError } from './logging';

/**
 * Phase 6C security suite (docs/SECURITY.md): authentication, sessions, authorization for every
 * route and role, CSRF and origins, CORS, security headers, document access, safe errors and logs,
 * and the production lock-down. Credentials here are test-only.
 */
type App = Awaited<ReturnType<typeof createTestApp>>;
const opened: { app: App; dir: string }[] = [];
afterEach(async () => {
  for (const { app, dir } of opened.splice(0)) {
    await app.close(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

let now = DEMO_NOW;
async function open(extra: Partial<AppConfig> = {}): Promise<App> {
  now = DEMO_NOW;
  const dir = mkdtempSync(join(tmpdir(), 'veyra-sec-'));
  const app = await createTestApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => now,
    rateLimits: { upload: 1000, processing: 1000, dev: 1000, login: 1000 },
    ...extra,
  });
  opened.push({ app, dir });
  return app;
}

const PASSWORD = 'test-only password 1';
async function user(app: App, role: Role, email = `${role.toLowerCase()}@toit.example`) {
  return app.users.create(
    { email, name: `${role} person`, role, password: PASSWORD },
    {
      userId: null,
      requestId: null,
    },
  );
}

function multipart(filename: string, bytes: Uint8Array, mime = 'application/pdf') {
  const boundary = '----veyra-sec-boundary';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
const scenario = (id: string) => {
  const s = scenarioById(id);
  if (!s) throw new Error(id);
  return { file: s.file, bytes: renderScenario(s) };
};

/** Uploads a scenario as the test's ADMIN session and lets the worker process it. */
async function invoice(app: App, id: string) {
  const { file, bytes } = scenario(id);
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/v1/documents',
    ...multipart(file, bytes),
  });
  expect(res.statusCode).toBe(201);
  await app.runner.drain();
  return res.json<{ documentId: string; invoiceId: string }>();
}

const login = (app: App, email: string, password: string, headers: Record<string, string> = {}) =>
  app.anonymous({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
    headers,
  });

const cookieOf = (res: { headers: Record<string, unknown> }) => {
  const set = res.headers['set-cookie'];
  const line = (Array.isArray(set) ? set : [set]).find((c) => String(c).includes('veyra_session='));
  return line ? String(line) : null;
};
const tokenOf = (setCookie: string) => /veyra_session=([^;]*)/.exec(setCookie)?.[1] ?? '';

/** A session for a user signed in through the real password sign-in. */
async function signedIn(app: App, role: Role): Promise<TestSession & { email: string }> {
  const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@toit.example`;
  await user(app, role, email);
  const res = await login(app, email, PASSWORD);
  expect(res.statusCode).toBe(200);
  const cookie = `${app.cookieName}=${tokenOf(cookieOf(res) ?? '')}`;
  const csrf = res.json<{ csrfToken: string }>().csrfToken;
  return {
    email,
    userId: res.json<{ user: { id: string } }>().user.id,
    cookie,
    csrf,
    headers: { cookie, [CSRF_HEADER]: csrf },
  };
}

describe('authentication', () => {
  it('signs in with email and password: HttpOnly, SameSite=Strict session cookie; only the CSRF token in the body', async () => {
    const app = await open();
    await user(app, 'FINANCE');
    const res = await login(app, ' Finance@Toit.example ', PASSWORD);
    expect(res.statusCode).toBe(200);
    const setCookie = cookieOf(res) ?? '';
    expect(setCookie).toMatch(/^veyra_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      authenticated: true,
      user: { email: 'finance@toit.example', role: 'FINANCE' },
      organization: { name: 'Toit' },
    });
    expect(JSON.stringify(body)).not.toContain(tokenOf(setCookie));
    expect(JSON.stringify(body)).not.toMatch(/argon2|passwordHash/);
    // The session works; the token is nowhere in the URL, only the cookie.
    const me = await app.anonymous({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `veyra_session=${tokenOf(setCookie)}` },
    });
    expect(me.json()).toMatchObject({ authenticated: true, user: { role: 'FINANCE' } });
  });

  it('a Secure, __Host- cookie outside development', async () => {
    const app = await open({ auth: { cookieSecure: true } });
    await user(app, 'ADMIN', 'admin2@toit.example');
    const setCookie = cookieOf(await login(app, 'admin2@toit.example', PASSWORD)) ?? '';
    expect(setCookie).toMatch(/^__Host-veyra_session=/);
    expect(setCookie).toMatch(/Secure/);
  });

  it('failures never reveal whether an account exists (unknown, wrong password, disabled, no password)', async () => {
    const app = await open();
    const f = await user(app, 'FINANCE');
    const d = await user(app, 'REVIEWER', 'disabled@toit.example');
    await app.users.update(d.id, { active: false }, { userId: null, requestId: null });
    const attempts = [
      login(app, 'nobody@toit.example', PASSWORD),
      login(app, 'finance@toit.example', 'wrong password!!'),
      login(app, 'disabled@toit.example', PASSWORD),
      login(app, 'approver@veyra.local', PASSWORD), // the designated approver has no password
    ];
    const bodies = (await Promise.all(attempts)).map((r) => {
      expect(r.statusCode).toBe(401);
      expect(cookieOf(r)).toBeNull();
      const rest = { ...r.json<{ error: Record<string, unknown> }>().error };
      delete rest.requestId;
      return JSON.stringify(rest);
    });
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('The email or password is not correct.');
    const failed = await app.veyra.db
      .select()
      .from(t.securityEvents)
      .where(eq(t.securityEvents.event, 'login.failed'));
    expect(failed).toHaveLength(4);
    expect(failed.map((e) => e.subjectUserId)).toContain(f.id);
    expect(JSON.stringify(failed)).not.toMatch(/wrong password|nobody@/);
  });

  it('rotates the session at sign-in: a session held before signing in is ended', async () => {
    const app = await open();
    await user(app, 'FINANCE');
    const first = tokenOf(cookieOf(await login(app, 'finance@toit.example', PASSWORD)) ?? '');
    const second = await login(app, 'finance@toit.example', PASSWORD, {
      cookie: `veyra_session=${first}`,
    });
    expect(tokenOf(cookieOf(second) ?? '')).not.toBe(first);
    const old = await app.anonymous({
      method: 'GET',
      url: '/api/v1/invoices',
      headers: { cookie: `veyra_session=${first}` },
    });
    expect(old.statusCode).toBe(401);
  });

  it('logout ends the session on the server (the old cookie no longer works)', async () => {
    const app = await open();
    const s = await signedIn(app, 'REVIEWER');
    const out = await app.anonymous({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: s.headers,
    });
    expect(out.statusCode).toBe(200);
    expect(cookieOf(out)).toMatch(/veyra_session=;/);
    const after = await app.anonymous({
      method: 'GET',
      url: '/api/v1/invoices',
      headers: s.headers,
    });
    expect(after.statusCode).toBe(401);
  });

  it('sessions expire (idle, absolute); expired, invalid and disabled-user sessions are rejected', async () => {
    const app = await open({ auth: { session: { idleMs: 60_000, absoluteMs: 10 * 60_000 } } });
    const s = await signedIn(app, 'FINANCE');
    const get = (headers: Record<string, string>) =>
      app.anonymous({ method: 'GET', url: '/api/v1/invoices', headers });
    expect((await get(s.headers)).statusCode).toBe(200);
    now = new Date(now.getTime() + 61_000);
    expect((await get(s.headers)).statusCode).toBe(401);

    const a = await signedIn(app, 'FINANCE');
    for (let i = 0; i < 12; i++) {
      now = new Date(now.getTime() + 50_000);
      if (i < 11) expect((await get(a.headers)).statusCode).toBe(200);
    }
    expect((await get(a.headers)).statusCode).toBe(401); // 10 min after sign-in, however active

    expect((await get({ cookie: 'veyra_session=forged-token' })).statusCode).toBe(401);
    const b = await signedIn(app, 'REVIEWER');
    await app.users.update(b.userId, { active: false }, { userId: null, requestId: null });
    expect((await get(b.headers)).statusCode).toBe(401);
  });

  it('concurrent sessions: each browser has its own; a password change ends all and continues on a fresh one', async () => {
    const app = await open();
    const one = await signedIn(app, 'FINANCE');
    const res = await login(app, one.email, PASSWORD);
    const two = `${app.cookieName}=${tokenOf(cookieOf(res) ?? '')}`;
    const get = (cookie: string) =>
      app.anonymous({ method: 'GET', url: '/api/v1/invoices', headers: { cookie } });
    expect((await get(one.cookie)).statusCode).toBe(200);
    expect((await get(two)).statusCode).toBe(200);
    const changed = await app.anonymous({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: one.headers,
      payload: { currentPassword: PASSWORD, newPassword: 'a brand new password' },
    });
    expect(changed.statusCode).toBe(200);
    expect((await get(one.cookie)).statusCode).toBe(401);
    expect((await get(two)).statusCode).toBe(401);
    expect((await get(`${app.cookieName}=${tokenOf(cookieOf(changed) ?? '')}`)).statusCode).toBe(
      200,
    );
  });

  it('sign-in attempts are rate limited per account', async () => {
    const app = await open({ rateLimits: { upload: 100, processing: 100, dev: 100, login: 3 } });
    await user(app, 'FINANCE');
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push((await login(app, 'finance@toit.example', 'nope nope nope')).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });

  it('demo sign-in: only with the demo PIN, only in demo mode, never in production', async () => {
    const app = await open({ auth: { demoPin: new Secret('8824') } });
    const wrong = await app.anonymous({
      method: 'POST',
      url: '/api/v1/auth/demo',
      payload: { pin: '0000' },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.anonymous({
      method: 'POST',
      url: '/api/v1/auth/demo',
      payload: { pin: '8824' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ user: { role: 'ADMIN' }, demoSignIn: true });

    const plain = await open({ demo: false, auth: { demoPin: new Secret('8824') } });
    expect(
      (
        await plain.anonymous({
          method: 'POST',
          url: '/api/v1/auth/demo',
          payload: { pin: '8824' },
        })
      ).statusCode,
    ).toBe(404);
    const prod = await open({
      environment: 'production',
      demo: true,
      allowFixtureExtractor: false,
      auth: { demoPin: new Secret('8824'), cookieSecure: true },
    });
    expect(
      (await prod.anonymous({ method: 'POST', url: '/api/v1/auth/demo', payload: { pin: '8824' } }))
        .statusCode,
    ).toBe(404);
    expect((await prod.anonymous({ method: 'GET', url: '/api/v1/auth/session' })).json()).toEqual({
      authenticated: false,
      demoSignIn: false,
    });
  });
});

describe('authorization', () => {
  it('every route declares its access, and every non-public route refuses anonymous requests', async () => {
    const app = await open();
    const table = app.server.routeAccess;
    expect(table.length).toBeGreaterThan(40);
    const pub = table.filter((r) => r.access === 'public').map((r) => `${r.method} ${r.url}`);
    expect(pub.sort()).toEqual(
      [
        'GET /api/v1/auth/session',
        'GET /api/v1/health',
        'GET /api/v1/health/live',
        'GET /api/v1/health/ready',
        'GET /api/v1/instance',
        'HEAD /api/v1/auth/session',
        'HEAD /api/v1/health',
        'HEAD /api/v1/health/live',
        'HEAD /api/v1/health/ready',
        'HEAD /api/v1/instance',
        'POST /api/v1/auth/login',
      ].sort(),
    );
    for (const r of table.filter((x) => x.access !== 'public')) {
      const url = r.url
        .replace(':id', '01K00000000000000000000000')
        .replace(':file', 'Vendors.xlsx')
        .replace(':name', 'invoices.csv')
        .replace(':key', 'x');
      const res = await app.anonymous({ method: r.method as 'GET', url });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      if (r.method !== 'HEAD')
        expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('a route without an access declaration stops the server from starting', async () => {
    const Fastify = (await import('fastify')).default;
    const { requireAccessDeclarations } = await import('./access');
    const bare = Fastify();
    requireAccessDeclarations(bare);
    expect(() => bare.get('/api/v1/forgotten', async () => ({}))).toThrow(/declares no access/);
    await bare.close();
  });

  it('REVIEWER: reads invoices and documents, answers questions; cannot upload, reject, reprocess, import, export, browse the ERP or manage users', async () => {
    const app = await open();
    const { documentId, invoiceId } = await invoice(app, 'S08');
    const r = await signedIn(app, 'REVIEWER');
    const as = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
      app.anonymous({ method, url, headers: r.headers, ...(payload ? { payload } : {}) });
    for (const url of [
      '/api/v1/invoices',
      `/api/v1/invoices/${invoiceId}`,
      '/api/v1/questions',
      `/api/v1/audit?invoiceId=${invoiceId}`,
      `/api/v1/documents/${documentId}/file`,
    ])
      expect((await as('GET', url)).statusCode, url).toBe(200);
    for (const [method, url] of [
      ['POST', `/api/v1/invoices/${invoiceId}/reject`],
      ['POST', `/api/v1/invoices/${invoiceId}/reprocess`],
      ['GET', '/api/v1/audit'],
      ['GET', '/api/v1/audit?scope=records'],
      ['GET', '/api/v1/erp/vendors'],
      ['GET', '/api/v1/imports'],
      ['GET', '/api/v1/exports/invoices.csv'],
      ['GET', '/api/v1/users'],
      ['GET', '/api/v1/security/events'],
      ['POST', '/api/v1/dev/reset'],
    ] as const)
      expect(
        (await as(method, url, method === 'POST' ? { reason: 'x' } : undefined)).statusCode,
        url,
      ).toBe(403);
    const upload = await app.anonymous({
      method: 'POST',
      url: '/api/v1/documents',
      headers: { ...r.headers, ...multipart(scenario('S02').file, scenario('S02').bytes).headers },
      payload: multipart(scenario('S02').file, scenario('S02').bytes).payload,
    });
    expect(upload.statusCode).toBe(403);
    // Denials are in the security audit trail.
    const denied = await app.veyra.db
      .select()
      .from(t.securityEvents)
      .where(
        and(eq(t.securityEvents.event, 'access.denied'), eq(t.securityEvents.userId, r.userId)),
      );
    expect(denied.length).toBeGreaterThanOrEqual(10);
  });

  it('REVIEWER can answer, but not with an option that rejects the invoice (that is a rejection)', async () => {
    const app = await open();
    const { invoiceId } = await invoice(app, 'S09');
    const q = (
      await app.veyra.db
        .select()
        .from(t.questions)
        .where(and(eq(t.questions.invoiceId, invoiceId), eq(t.questions.status, 'open')))
    )[0];
    if (!q) throw new Error('S09 should ask a question');
    const options = JSON.parse(q.optionsJson) as { id: string; effect: { type: string } }[];
    const reject = options.find((o) => o.effect.type === 'REJECT_INVOICE');
    if (!reject) throw new Error('expected a reject option');
    const r = await signedIn(app, 'REVIEWER');
    const res = await app.anonymous({
      method: 'POST',
      url: `/api/v1/questions/${q.id}/answer`,
      headers: r.headers,
      payload: { optionId: reject.id, input: null },
    });
    expect(res.statusCode).toBe(403);
    expect((await app.veyra.invoiceRow(app.veyra.db, invoiceId)).state).toBe('NEEDS_INPUT');
  });

  it('FINANCE: the workflow, ERP, imports and exports; not users or the security audit', async () => {
    const app = await open();
    const f = await signedIn(app, 'FINANCE');
    const get = (url: string) => app.anonymous({ method: 'GET', url, headers: f.headers });
    for (const url of [
      '/api/v1/erp/vendors',
      '/api/v1/imports',
      '/api/v1/audit',
      '/api/v1/exports/invoices.csv',
    ])
      expect((await get(url)).statusCode, url).toBe(200);
    expect((await get('/api/v1/users')).statusCode).toBe(403);
    expect((await get('/api/v1/security/events')).statusCode).toBe(403);
  });

  it('ADMIN manages users; nothing returned about a user includes a password or hash', async () => {
    const app = await open();
    const a = await signedIn(app, 'ADMIN');
    const created = await app.anonymous({
      method: 'POST',
      url: '/api/v1/users',
      headers: a.headers,
      payload: {
        email: 'new@toit.example',
        name: 'New',
        role: 'REVIEWER',
        password: 'new user password',
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const list = await app.anonymous({ method: 'GET', url: '/api/v1/users', headers: a.headers });
    expect(list.body).not.toMatch(/argon2|new user password|passwordHash/);
    const disabled = await app.anonymous({
      method: 'PATCH',
      url: `/api/v1/users/${id}`,
      headers: a.headers,
      payload: { active: false },
    });
    expect(disabled.json()).toMatchObject({ active: false });
    const events = await app.anonymous({
      method: 'GET',
      url: '/api/v1/security/events',
      headers: a.headers,
    });
    expect(events.json<{ event: string }[]>().map((e) => e.event)).toEqual(
      expect.arrayContaining(['user.created', 'user.disabled', 'login.succeeded']),
    );
    expect(events.body).not.toMatch(/argon2|new user password|test-only password/);
  });

  it('the application core refuses an unauthorized actor too (defence in depth)', async () => {
    const app = await open();
    const { invoiceId } = await invoice(app, 'S08');
    const r = await user(app, 'REVIEWER');
    await expect(app.veyra.reject(invoiceId, 'no', r.id)).rejects.toThrow(/permission/);
    await expect(app.veyra.reprocess(invoiceId, r.id)).rejects.toThrow(/permission/);
    await expect(
      app.veyra.upload({ filename: 'x.pdf', bytes: scenario('S02').bytes }, r.id),
    ).rejects.toThrow(/permission/);
  });

  it('the acting user recorded in the audit trail is the signed-in user', async () => {
    const app = await open();
    const { invoiceId } = await invoice(app, 'S08');
    const f = await signedIn(app, 'FINANCE');
    const res = await app.anonymous({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/reject`,
      headers: f.headers,
      payload: { reason: 'Not ours' },
    });
    expect(res.statusCode).toBe(200);
    const rejected = await app.veyra.db
      .select()
      .from(t.auditEvents)
      .where(
        and(eq(t.auditEvents.invoiceId, invoiceId), eq(t.auditEvents.event, 'invoice.rejected')),
      );
    expect(rejected[0]?.actorUserId).toBe(f.userId);
  });
});

describe('CSRF and origins', () => {
  it('a state-changing request without the session’s CSRF token is refused', async () => {
    const app = await open();
    const { invoiceId } = await invoice(app, 'S08');
    const f = await signedIn(app, 'FINANCE');
    for (const csrf of [undefined, 'wrong', `${f.csrf}x`, (await signedIn(app, 'FINANCE')).csrf]) {
      const res = await app.anonymous({
        method: 'POST',
        url: `/api/v1/invoices/${invoiceId}/reject`,
        headers: { cookie: f.cookie, ...(csrf ? { [CSRF_HEADER]: csrf } : {}) },
        payload: { reason: 'forged' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('CSRF_REJECTED');
    }
    expect((await app.veyra.invoiceRow(app.veyra.db, invoiceId)).state).toBe('NEEDS_INPUT');
  });

  it('cross-site requests cannot perform invoice actions, even with a valid cookie and token', async () => {
    const app = await open();
    const { invoiceId } = await invoice(app, 'S08');
    const f = await signedIn(app, 'FINANCE');
    const q = (
      await app.veyra.db.select().from(t.questions).where(eq(t.questions.invoiceId, invoiceId))
    )[0];
    for (const extra of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ])
      for (const [url, payload] of [
        [`/api/v1/invoices/${invoiceId}/reject`, { reason: 'forged' }],
        [`/api/v1/invoices/${invoiceId}/reprocess`, {}],
        [`/api/v1/questions/${q?.id ?? ''}/answer`, { optionId: 'x', input: null }],
        ['/api/v1/auth/logout', {}],
        ['/api/v1/auth/login', { email: f.email, password: PASSWORD }],
      ] as const) {
        const res = await app.anonymous({
          method: 'POST',
          url,
          headers: { ...f.headers, ...extra },
          payload,
        });
        expect(res.statusCode, `${url} ${JSON.stringify(extra)}`).toBe(403);
      }
    expect((await app.veyra.invoiceRow(app.veyra.db, invoiceId)).state).toBe('NEEDS_INPUT');
    // From Veyra's own origin it works.
    const ok = await app.anonymous({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/reject`,
      headers: { ...f.headers, origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' },
      payload: { reason: 'Duplicate' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('CORS: none by default; only configured origins, exactly, never "*"', async () => {
    const app = await open();
    const pre = await app.anonymous({
      method: 'OPTIONS',
      url: '/api/v1/invoices',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();

    const cors = await open({ auth: { corsOrigins: ['https://books.toit.example'] } });
    const allowed = await cors.anonymous({
      method: 'OPTIONS',
      url: '/api/v1/invoices',
      headers: { origin: 'https://books.toit.example', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://books.toit.example');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const other = await cors.anonymous({
      method: 'OPTIONS',
      url: '/api/v1/invoices',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('security headers', () => {
  it('every API response: CSP, nosniff, no referrer, no framing, permissions policy, no caching', async () => {
    const app = await open();
    for (const url of ['/api/v1/health', '/api/v1/invoices', '/api/v1/nope']) {
      const res = await app.server.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy'], url).toMatch(/default-src 'none'/);
      expect(res.headers['content-security-policy'], url).toMatch(/frame-ancestors 'none'/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['permissions-policy']).toMatch(/camera=\(\)/);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('documents', () => {
  it('downloads are authenticated, authorized, audited and served inert', async () => {
    const app = await open();
    const { documentId } = await invoice(app, 'S01');
    const url = `/api/v1/documents/${documentId}/file`;
    expect((await app.anonymous({ method: 'GET', url })).statusCode).toBe(401);
    const res = await app.server.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(String(res.headers['content-disposition'])).toMatch(/^inline; filename="[^"\\/]+"/);
    const accessed = await app.veyra.db
      .select()
      .from(t.securityEvents)
      .where(eq(t.securityEvents.event, 'document.accessed'));
    expect(accessed.map((e) => JSON.parse(e.detailJson) as unknown)).toEqual([{ documentId }]);
  });

  it('opaque ids only: no storage paths in any response; traversal attempts are not ids', async () => {
    const app = await open();
    const { documentId, invoiceId } = await invoice(app, 'S01');
    for (const url of [
      '/api/v1/documents',
      `/api/v1/documents/${documentId}`,
      `/api/v1/invoices/${invoiceId}`,
    ]) {
      const body = (await app.server.inject({ method: 'GET', url })).body;
      expect(body, url).not.toMatch(/storage_?path|uploads\/|veyra-sec-|\.pdf"?:/i);
    }
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e', `${documentId}%00`, 'x'.repeat(26)])
      expect(
        (await app.server.inject({ method: 'GET', url: `/api/v1/documents/${bad}/file` }))
          .statusCode,
        bad,
      ).toBeGreaterThanOrEqual(400);
  });

  it('only real PDFs and images are accepted, whatever the name says', async () => {
    const app = await open();
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new Uint8Array(200)]);
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(100)]);
    for (const [name, bytes] of [
      ['invoice.pdf', exe],
      ['invoice.png', html],
      ['invoice.pdf', zip],
      ['invoice.svg', new TextEncoder().encode('<svg onload="alert(1)"/>')],
    ] as const) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/api/v1/documents',
        ...multipart(name, bytes),
      });
      expect(res.statusCode, name).toBe(415);
    }
  });
});

describe('filenames and the AI boundary', () => {
  it('an unsafe filename is sanitized: never a path, never markup', async () => {
    const app = await open();
    const { bytes } = scenario('S01');
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart('../../etc/<script>x</script>\u0000passwd.pdf', bytes),
    });
    expect(res.statusCode).toBe(201);
    const { documentId } = res.json<{ documentId: string }>();
    const row = (
      await app.veyra.db.select().from(t.documents).where(eq(t.documents.id, documentId))
    )[0];
    expect(row?.filename).not.toMatch(/\.\.|[\\/<>]/);
    expect(row?.filename).not.toContain(String.fromCharCode(0));
    expect(row?.storagePath).toBe(`${documentId}.pdf`);
    const file = await app.server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/file`,
    });
    expect(String(file.headers['content-disposition'])).not.toMatch(/\.\.\/|<script/);
  });

  it('real extraction makes no outbound request without Ollama, and logs ids, not invoice contents', async () => {
    const lines: string[] = [];
    const log = createLogger(
      { level: 'debug', environment: 'staging' },
      new Writable({
        write(chunk: Buffer, _e, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    );
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      calls.push(String(input));
      return Promise.reject(new Error('no network in this test'));
    }) as typeof fetch;
    try {
      // No fixture extractor: the real local reader (pdf.js / Tesseract) reads the document.
      const app = await open({ allowFixtureExtractor: false, demo: false, log });
      const { invoiceId } = await invoice(app, 'S01');
      const detail = (
        await app.server.inject({ method: 'GET', url: `/api/v1/invoices/${invoiceId}` })
      ).json<{ vendor?: { gstin?: string | null } | null }>();
      expect(calls).toEqual([]);
      const logged = lines.join('\n');
      expect(logged).toContain(invoiceId);
      // Nothing read from the document (GSTINs, amounts, document text) reaches a log line.
      expect(logged).not.toMatch(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b|%PDF|TAX INVOICE/i);
      if (detail.vendor?.gstin) expect(logged).not.toContain(detail.vendor.gstin);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('secrets, errors and logs', () => {
  it('no response carries the database URL, a password hash, a session token or a stack', async () => {
    const lines: string[] = [];
    const log = createLogger(
      { level: 'debug', environment: 'staging' },
      new Writable({
        write(chunk: Buffer, _e, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    );
    const app = await open({ log });
    const s = await signedIn(app, 'ADMIN');
    const bodies: string[] = [];
    for (const url of [
      '/api/v1/health',
      '/api/v1/health/ready',
      '/api/v1/auth/session',
      '/api/v1/users',
      '/api/v1/security/events',
      '/api/v1/invoices/01K00000000000000000000000',
      '/api/v1/invoices/not-an-id',
    ])
      bodies.push((await app.anonymous({ method: 'GET', url, headers: s.headers })).body);
    bodies.push(
      (
        await app.anonymous({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: '{"email": ',
          headers: { 'content-type': 'application/json' },
        })
      ).body,
    );
    const all = bodies.join('\n');
    const token = s.cookie.split('=')[1] ?? '';
    expect(all).not.toMatch(
      /postgres(ql)?:\/\/|veyra_test|argon2|\bat \S+\.ts:\d+|SELECT |node_modules/i,
    );
    expect(all).not.toContain(token);
    const logged = lines.join('\n');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(s.csrf);
    expect(logged).not.toMatch(/test-only password|postgres(ql)?:\/\/|argon2/);
  });

  it('the redaction helper masks credentials, identifiers and document text', () => {
    const out = JSON.stringify(
      redact({
        password: 'p',
        sessionToken: 't',
        csrf: 'c',
        authorization: 'Bearer abc.def',
        cookie: 'veyra_session=zzz',
        DATABASE_URL: 'postgres://u:p@h/db',
        bank: { ifsc: 'HDFC0001234', accountNumber: '123456789' },
        pan: 'ABCDE1234F',
        vendorGstin: '27ABCDE1234F1Z5',
        ocrText: 'TAX INVOICE ...',
        note: 'connecting to postgres://u:secret@db/veyra with PAN ABCDE1234F and 27ABCDE1234F1Z5',
        invoiceId: '01K00000000000000000000000',
      }),
    );
    expect(out).not.toMatch(
      /"p"|"t"|"c"|abc\.def|zzz|u:p@|HDFC|123456789|ABCDE1234F|TAX INVOICE|secret@/,
    );
    expect(out).toContain('01K00000000000000000000000'); // opaque ids stay
  });

  it('database errors are logged without their SQL, parameters or values', () => {
    const err = Object.assign(
      new Error(
        'Failed query: insert into "invoices" values ($1)\nparams: 27ABCDE1234F1Z5,SSS/26-27/1',
      ),
      {
        name: 'DrizzleQueryError',
        cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
      },
    );
    const safe = JSON.stringify(safeError(err));
    expect(safe).not.toMatch(/27ABCDE|SSS\/26|insert into|duplicate key/);
    expect(safeError(err)).toMatchObject({ type: 'DrizzleQueryError', code: '23505' });
  });
});

describe('production lock-down', () => {
  it('no dev, demo or test routes; the session probe offers no demo sign-in', async () => {
    const app = await open({
      environment: 'production',
      demo: true,
      allowFixtureExtractor: false,
      auth: { cookieSecure: true, demoPin: new Secret('8824') },
    });
    const urls = app.server.routeAccess.map((r) => r.url);
    expect(urls.filter((u) => /\/dev\/|\/demo|\/test|debug/.test(u))).toEqual([]);
    for (const [method, url] of [
      ['POST', '/api/v1/dev/reset'],
      ['GET', '/api/v1/dev/scenarios'],
      ['POST', '/api/v1/auth/demo'],
    ] as const)
      expect((await app.server.inject({ method, url })).statusCode).toBe(404);
    // A test session still works: authentication does not depend on the demo.
    const s = await testSession(app, { role: 'REVIEWER' });
    expect(
      (await app.anonymous({ method: 'GET', url: '/api/v1/invoices', headers: s.headers }))
        .statusCode,
    ).toBe(200);
  });
});
