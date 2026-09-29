import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DemoRoutedExtractor, renderScenario, scenarioById } from '@veyra/extractor';
import { createApp, type AppConfig } from './app';
import {
  knownMigrations,
  openVeyraDb,
  pendingMigrations,
  PendingMigrationsError,
  rowsOf,
} from './db/open';
import { createTestDatabase, type TestDatabase } from './test/database';
import * as t from './db/schema';
import { createLogger } from './http/logging';
import { LocalDocumentStorage, StorageUnavailableError, type DocumentStorage } from './storage';
import { DEMO_NOW, createHarness, type Harness } from './test/harness';
import { injectAs, testSession, type TestSession } from './test/auth';
import { CrashSignal } from './workflow/commit';

/**
 * Phase 6: the production foundation as a deployed instance sees it. Health, production lock-down,
 * safe errors with request ids, structured logs without secrets, rate limits, upload limits,
 * storage failures, job leases and graceful shutdown.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const opened: { app: App; dir: string; database: TestDatabase }[] = [];
let h: Harness | undefined;
afterEach(async () => {
  for (const { app, dir, database } of opened.splice(0)) {
    await app.close(0);
    await database.drop();
    rmSync(dir, { recursive: true, force: true });
  }
  await h?.close();
  h = undefined;
});

const sessions = new Map<App, TestSession>();
const anonymousOf = new Map<App, App['server']['inject']>();

async function open(extra: Partial<AppConfig> = {}): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-prod-'));
  const database = await createTestDatabase();
  const app = await createApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
    database: { url: database.url },
    ...extra,
  });
  opened.push({ app, dir, database });
  const session = await testSession(app);
  sessions.set(app, session);
  anonymousOf.set(app, injectAs(app, session));
  return app;
}

function logCapture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const l of chunk.toString().split('\n').filter(Boolean))
        lines.push(JSON.parse(l) as Record<string, unknown>);
      done();
    },
  });
  return { lines, log: createLogger({ level: 'debug', environment: 'staging' }, stream) };
}

function multipart(filename: string, bytes: Uint8Array, mime = 'application/pdf') {
  const boundary = '----veyra-prod-boundary';
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
const S01 = () => {
  const s = scenarioById('S01');
  if (!s) throw new Error('S01');
  return { file: s.file, bytes: renderScenario(s) };
};

/** A storage that is down until `up()` is called. */
class FlakyStorage implements DocumentStorage {
  readonly kind = 'local' as const;
  down = true;
  constructor(readonly inner: LocalDocumentStorage) {}
  #gate() {
    if (this.down) throw new StorageUnavailableError({ cause: new Error('EIO /secret/path') });
  }
  async put(...a: Parameters<DocumentStorage['put']>) {
    return this.inner.put(...a);
  }
  async get(...a: Parameters<DocumentStorage['get']>) {
    this.#gate();
    return this.inner.get(...a);
  }
  async exists(k: string) {
    return this.inner.exists(k);
  }
  async metadata(k: string) {
    return this.inner.metadata(k);
  }
  async delete(k: string) {
    return this.inner.delete(k);
  }
  async withLocalFile<T>(k: string, fn: (p: string) => Promise<T>, v?: { sha256: string }) {
    this.#gate();
    return this.inner.withLocalFile(k, fn, v);
  }
  async check() {
    this.#gate();
  }
}

describe('health', () => {
  it('liveness answers without checking anything', async () => {
    const app = await open();
    const res = await app.server.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('readiness checks database, storage and the worker; reports ERP and jobs; no secrets', async () => {
    const app = await open({ environment: 'staging' });
    const notYet = await app.server.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(notYet.statusCode).toBe(503); // the worker has not started
    expect(notYet.json()).toMatchObject({ checks: { worker: { status: 'fail' } } });
    app.runner.start(60_000);
    const res = await app.server.inject({ method: 'GET', url: '/api/v1/system/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ready',
      environment: 'staging',
      checks: {
        database: { status: 'ok' },
        storage: { status: 'ok' },
        worker: { status: 'ok' },
        erp: { status: 'CONNECTED' },
      },
      jobs: { queued: 0, running: 0, expired: 0, failedLast24h: 0 },
    });
    expect(res.body).not.toMatch(/veyra-prod-|\.db|uploads|\/tmp/);
  });

  it('deployed: anonymous probes get statuses only; the detail is for an ADMIN (Phase 7C)', async () => {
    const app = await open({ environment: 'staging' });
    app.runner.start(60_000);
    const anonymous = anonymousOf.get(app) ?? app.server.inject;
    const ready = await anonymous({ method: 'GET', url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ready',
      checks: { database: { status: 'ok' }, storage: { status: 'ok' }, worker: { status: 'ok' } },
    });
    const health = await anonymous({ method: 'GET', url: '/api/v1/health' });
    expect(health.json()).toEqual({ ok: true, demo: true });
    // The full report needs a signed-in ADMIN.
    expect((await anonymous({ method: 'GET', url: '/api/v1/system/status' })).statusCode).toBe(401);
    const finance = await testSession(app, { role: 'FINANCE' });
    const denied = await anonymous({
      method: 'GET',
      url: '/api/v1/system/status',
      headers: finance.headers,
    });
    expect(denied.statusCode).toBe(403);
  });

  it('deployed: a failing check still reports its code to anonymous probes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'veyra-prod-'));
    const storage = new FlakyStorage(new LocalDocumentStorage(join(dir, 'u')));
    const app = await open({ environment: 'staging', storage });
    app.runner.start(60_000);
    const anonymous = anonymousOf.get(app) ?? app.server.inject;
    const res = await anonymous({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'not_ready',
      checks: { storage: { status: 'fail', code: 'STORAGE_UNAVAILABLE' } },
    });
    expect(res.body).not.toMatch(/jobs|pool|environment|secret|EIO/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('readiness fails (503) when storage is unavailable, with a code and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'veyra-prod-'));
    const storage = new FlakyStorage(new LocalDocumentStorage(join(dir, 'u')));
    const app = await open({ storage });
    app.runner.start(60_000);
    const res = await app.server.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'not_ready',
      checks: { storage: { status: 'fail', code: 'STORAGE_UNAVAILABLE' } },
    });
    expect(res.body).not.toMatch(/secret|EIO/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('readiness fails when the database is gone', async () => {
    const app = await open();
    app.runner.start(60_000);
    await app.database.close(); // the database goes away
    const res = await app.server.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      checks: { database: { status: 'fail', code: 'DATABASE_UNAVAILABLE' } },
      jobs: null,
    });
    app.runner.stop();
  });
});

describe('production lock-down', () => {
  it('production has no dev, reset or demo-scenario endpoints, whatever the caller asks for', async () => {
    const app = await open({ environment: 'production', demo: true, allowFixtureExtractor: true });
    for (const [method, url] of [
      ['POST', '/api/v1/dev/reset'],
      ['GET', '/api/v1/dev/scenarios'],
      ['POST', '/api/v1/dev/scenarios/clean'],
    ] as const) {
      const res = await app.server.inject({ method, url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    const health = (await app.server.inject({ method: 'GET', url: '/api/v1/health' })).json();
    expect(health).toEqual({ ok: true, demo: false });
    // No demo seed either: production starts with an empty business.
    expect(await app.veyra.erp.listVendors()).toEqual([]);
  });

  it('production never reads documents with the fixture extractor, even if asked', async () => {
    const prod = await open({ environment: 'production', allowFixtureExtractor: true });
    expect(prod.veyra.extractor).not.toBeInstanceOf(DemoRoutedExtractor);
    const staging = await open({ environment: 'staging', allowFixtureExtractor: true });
    expect(staging.veyra.extractor).toBeInstanceOf(DemoRoutedExtractor);
  });

  it('staging keeps the demo', async () => {
    const app = await open({ environment: 'staging' });
    const res = await app.server.inject({ method: 'GET', url: '/api/v1/dev/scenarios' });
    expect(res.statusCode).toBe(200);
  });

  it('refuses to start on a database with pending migrations when auto-migration is off', async () => {
    const empty = await createTestDatabase({ bare: true });
    try {
      await expect(openVeyraDb({ url: empty.url, migrate: false })).rejects.toThrow(
        PendingMigrationsError,
      );
      // Applied once; applying again is a no-op; then it opens without migrating.
      await (await openVeyraDb({ url: empty.url, migrate: true })).close();
      await (await openVeyraDb({ url: empty.url, migrate: true })).close();
      const db = await openVeyraDb({ url: empty.url, migrate: false });
      expect(await pendingMigrations(db.db)).toEqual([]);
      const applied = await db.db.execute(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      expect(rowsOf(applied)).toEqual([{ n: knownMigrations().length }]);
      await db.close();
    } finally {
      await empty.drop();
    }
  });
});

describe('errors and request ids', () => {
  it('every response carries a generated request id; errors include it', async () => {
    const app = await open();
    const ok = await app.server.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(ok.headers['x-request-id']).toMatch(/^[0-9A-Z]{26}$/);
    const nf = await app.server.inject({
      method: 'GET',
      url: '/api/v1/invoices/01K0000000000000000000ZZZZ',
      // Not behind a trusted proxy: a client-supplied id is ignored.
      headers: { 'x-request-id': 'edge-req-12345678' },
    });
    expect(nf.headers['x-request-id']).toMatch(/^[0-9A-Z]{26}$/);
    expect(nf.json()).toMatchObject({
      error: { code: 'NOT_FOUND', requestId: nf.headers['x-request-id'] },
    });
  });

  it('behind a trusted proxy its id is reused, but only when it looks like an id', async () => {
    const app = await open({ trustProxy: 1 });
    const kept = await app.server.inject({
      method: 'GET',
      url: '/api/v1/health/live',
      headers: { 'x-request-id': 'edge-req-12345678' },
    });
    expect(kept.headers['x-request-id']).toBe('edge-req-12345678');
    const odd = await app.server.inject({
      method: 'GET',
      url: '/api/v1/health/live',
      headers: { 'x-request-id': '<script>alert(1)</script>\nlevel=error' },
    });
    expect(odd.headers['x-request-id']).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('malformed JSON, unknown routes and oversized bodies get safe, stable errors', async () => {
    const app = await open({
      limits: {
        maxUploadBytes: 20 * 1024 * 1024,
        maxJsonBodyBytes: 2048,
        maxPdfPages: 20,
        maxImageSide: 12_000,
        maxImagePixels: 40_000_000,
      },
    });
    const bad = await app.server.inject({
      method: 'POST',
      url: '/api/v1/invoices/01K0000000000000000000ZZZZ/reject',
      headers: { 'content-type': 'application/json' },
      payload: '{"reason": ',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      error: { code: 'BAD_REQUEST', message: 'The request could not be read.' },
    });
    expect(bad.body).not.toMatch(/Unexpected|JSON\.parse|at |\.ts/);
    const big = await app.server.inject({
      method: 'POST',
      url: '/api/v1/invoices/01K0000000000000000000ZZZZ/reject',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'x'.repeat(5000) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: { code: 'TOO_LARGE' } });
    const none = await app.server.inject({ method: 'GET', url: '/api/v1/../../etc/passwd' });
    expect(none.statusCode).toBe(404);
    expect(none.body).not.toMatch(/root:/);
  });

  it('an internal failure answers 500 INTERNAL with a request id: no stack, SQL or path', async () => {
    const { lines, log } = logCapture();
    const app = await open({ log });
    await app.veyra.db.execute(sql`drop table questions`);
    const res = await app.server.inject({ method: 'GET', url: '/api/v1/questions' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong.',
        details: {},
        requestId: res.headers['x-request-id'],
      },
    });
    expect(res.body).not.toMatch(/SQLITE|no such table|questions|at |\/tmp|\.ts/);
    // The detail is in the server log, correlated by request id.
    expect(lines.find((l) => l.msg === 'unhandled error')).toMatchObject({
      reqId: res.headers['x-request-id'],
    });
  });
});

describe('uploads and input safety', () => {
  it('oversized uploads are refused at the configured limit', async () => {
    const app = await open({
      limits: {
        maxUploadBytes: 64 * 1024,
        maxJsonBodyBytes: 1024 * 1024,
        maxPdfPages: 20,
        maxImageSide: 12_000,
        maxImagePixels: 40_000_000,
      },
    });
    const bytes = new Uint8Array(100 * 1024).fill(0x41);
    bytes.set(new TextEncoder().encode('%PDF-1.4'));
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart('big.pdf', bytes),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({
      error: { code: 'TOO_LARGE', message: 'Files up to 64 KB are accepted.' },
    });
  });

  it('the file type is decided by its bytes; names cannot choose where a file is stored', async () => {
    const app = await open();
    const fake = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart(
        'invoice.pdf',
        new TextEncoder().encode('MZ\u0090 not a pdf'),
        'application/pdf',
      ),
    });
    expect(fake.statusCode).toBe(415);
    const { file, bytes } = S01();
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart(`../../../../etc/${file}`, bytes),
    });
    expect(res.statusCode).toBe(201);
    const { documentId } = res.json<{ documentId: string }>();
    const doc = (
      await app.veyra.db.select().from(t.documents).where(eq(t.documents.id, documentId)).limit(1)
    )[0];
    expect(doc?.storagePath).toBe(`${documentId}.pdf`);
    expect(doc?.filename).not.toMatch(/\.\.|\//);
    const back = await app.server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/file`,
    });
    expect(Buffer.from(back.rawPayload)).toEqual(Buffer.from(bytes));
    const traversal = await app.server.inject({
      method: 'GET',
      url: '/api/v1/documents/..%2F..%2Fetc%2Fpasswd/file',
    });
    expect(traversal.statusCode).toBe(422);
  });

  it('unsafe filenames (null bytes, control characters, empty, paths) are neutralised', async () => {
    const app = await open();
    const { bytes } = S01();
    for (const [i, name] of [
      'in\u0000voice.pdf',
      '',
      'C:\\Windows\\evil.pdf',
      '/etc/passwd',
    ].entries()) {
      const copy = new Uint8Array([...bytes, ...new TextEncoder().encode(`\n% ${i}\n`)]);
      const { documentId } = await app.veyra.upload({ filename: name, bytes: copy });
      const doc = (
        await app.veyra.db.select().from(t.documents).where(eq(t.documents.id, documentId)).limit(1)
      )[0];
      expect(doc?.storagePath).toBe(`${documentId}.pdf`);
      expect(doc?.filename).toMatch(/^[\w.\- ()]+$/);
      expect(doc?.filename).not.toMatch(/\.\.|\/|\\/);
    }
  });

  it('the same file twice (same checksum) is refused and stored once', async () => {
    const app = await open();
    const { file, bytes } = S01();
    const first = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart(file, bytes),
    });
    expect(first.statusCode).toBe(201);
    const again = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart('renamed.pdf', bytes),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'DUPLICATE_UPLOAD' } });
    expect(await app.veyra.db.select().from(t.documents)).toHaveLength(1);
    expect(readdirSync((app.storage as LocalDocumentStorage).root)).toHaveLength(1);
  });

  it('a stored file that went missing answers 404 with no path', async () => {
    const app = await open();
    const { file, bytes } = S01();
    const { documentId } = await app.veyra.upload({ filename: file, bytes });
    await app.storage.delete(`${documentId}.pdf`);
    const res = await app.server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/file`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: { code: 'NOT_FOUND', requestId: expect.any(String) },
    });
    expect(res.body).not.toMatch(/\/tmp|uploads|ENOENT|\.pdf/);
  });

  it('a stored document that no longer matches its checksum is never served', async () => {
    const app = await open();
    const { file, bytes } = S01();
    const { documentId } = await app.veyra.upload({ filename: file, bytes });
    // Someone swaps the file on disk behind Veyra's back.
    writeFileSync(
      (app.storage as LocalDocumentStorage).pathOf(`${documentId}.pdf`),
      '%PDF-1.4 swapped %%EOF',
    );
    const res = await app.server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/file`,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'STORAGE_INTEGRITY' } });
  });
});

describe('rate limits', () => {
  it('uploads over the limit get 429 with Retry-After and a safe body', async () => {
    const app = await open({ rateLimits: { upload: 2, processing: 100, dev: 100, login: 100 } });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push(
        (
          await app.server.inject({
            method: 'POST',
            url: '/api/v1/documents',
            ...multipart('x.pdf', new TextEncoder().encode('nope')),
          })
        ).statusCode,
      );
    expect(codes).toEqual([415, 415, 429]);
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart('x.pdf', new TextEncoder().encode('nope')),
    });
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    expect(res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    // Reads are not limited.
    expect((await app.server.inject({ method: 'GET', url: '/api/v1/invoices' })).statusCode).toBe(
      200,
    );
  });

  it('demo endpoints are limited too', async () => {
    const app = await open({ rateLimits: { upload: 100, processing: 100, dev: 1, login: 100 } });
    await app.server.inject({ method: 'GET', url: '/api/v1/dev/scenarios' });
    const res = await app.server.inject({ method: 'GET', url: '/api/v1/dev/scenarios' });
    expect(res.statusCode).toBe(429);
  });
});

describe('structured logs', () => {
  it('one line per request with id, route, status and duration; no secrets or bodies', async () => {
    const { lines, log } = logCapture();
    const app = await open({ log });
    const session = sessions.get(app);
    if (!session) throw new Error('no session');
    const { file, bytes } = S01();
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: {
        ...multipart(file, bytes).headers,
        authorization: 'Bearer sk_live_secret_token',
        cookie: `${session.cookie}; other=abc123secret`,
        'x-veyra-csrf': session.csrf,
      },
      payload: multipart(file, bytes).payload,
    });
    const reqId = res.headers['x-request-id'];
    const { documentId, invoiceId } = res.json<{ documentId: string; invoiceId: string }>();
    // Every line of the request carries its id, including the domain line with the document.
    expect(lines.find((l) => l.msg === 'document stored')).toMatchObject({
      reqId,
      documentId,
      invoiceId,
    });
    const line = lines.find((l) => l.msg === 'request' && l.route === '/api/v1/documents');
    expect(line).toMatchObject({
      level: 'info',
      service: 'veyra-api',
      env: 'staging',
      method: 'POST',
      status: 201,
      reqId,
      durationMs: expect.any(Number),
    });
    const all = JSON.stringify(lines);
    expect(all).not.toMatch(/sk_live|abc123secret|Bearer|SSS\/26-27|%PDF/);
    // Neither the session token nor the CSRF token ever reaches a log line.
    expect(all).not.toContain(session.cookie.split('=')[1]);
    expect(all).not.toContain(session.csrf);
    expect(line).toMatchObject({ userId: session.userId }); // opaque id, not a name or email
  });

  it('the logger redacts credentials even if something tries to log them', () => {
    const { lines, log } = logCapture();
    log.info(
      {
        req: { headers: { authorization: 'Bearer x', cookie: 'c=1' } },
        erp: { apiKey: 'k1', password: 'p1', token: 't1' },
      },
      'oops',
    );
    expect(JSON.stringify(lines)).not.toMatch(/Bearer x|c=1|"k1"|"p1"|"t1"/);
    expect(lines[0]).toMatchObject({
      erp: { apiKey: '[redacted]', password: '[redacted]', token: '[redacted]' },
    });
  });
});

describe('jobs: retries, leases and shutdown', () => {
  it('storage unavailable while reading is retried, then processing continues; nothing duplicated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'veyra-prod-'));
    const storage = new FlakyStorage(new LocalDocumentStorage(join(dir, 'u')));
    const app = await open({ storage });
    const { file, bytes } = S01();
    const { invoiceId } = await app.veyra.upload({ filename: file, bytes });
    await app.runner.drain();
    const job = (await app.veyra.latestJobs(invoiceId))[0];
    expect(job).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastError: 'Document storage is not available right now.',
    });
    expect((await app.veyra.invoiceRow(app.veyra.db, invoiceId)).state).toBe('EXTRACTING');
    storage.down = false;
    await app.veyra.db.update(t.jobs).set({ runAfter: '2000-01-01T00:00:00.000Z' });
    await app.runner.drain();
    expect((await app.veyra.invoiceRow(app.veyra.db, invoiceId)).state).toBe(
      'VERIFIED_PENDING_PAYMENT',
    );
    expect(await app.veyra.db.select().from(t.invoices)).toHaveLength(1);
    expect(await app.veyra.db.select().from(t.extractions)).toHaveLength(1);
    expect(await app.veyra.erp.listPurchaseInvoices()).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries are bounded: after 5 attempts the invoice fails visibly with the reason recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'veyra-prod-'));
    const storage = new FlakyStorage(new LocalDocumentStorage(join(dir, 'u')));
    const app = await open({ storage });
    const { file, bytes } = S01();
    const { invoiceId } = await app.veyra.upload({ filename: file, bytes });
    for (let i = 0; i < 6; i++) {
      await app.veyra.db.update(t.jobs).set({ runAfter: '2000-01-01T00:00:00.000Z' });
      await app.runner.drain();
    }
    expect((await app.veyra.latestJobs(invoiceId))[0]).toMatchObject({
      status: 'failed',
      attempts: 5,
    });
    expect(await app.veyra.invoiceRow(app.veyra.db, invoiceId)).toMatchObject({
      state: 'FAILED',
      failureReason: 'Document storage is not available right now.',
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a job whose worker disappeared is re-queued after its lease, then completes once', async () => {
    h = await createHarness();
    const { file, bytes } = S01();
    const { invoiceId } = await h.veyra.upload({ filename: file, bytes });
    const claimed = await h.veyra.claimJob(); // a worker takes it… and dies
    expect(claimed).toMatchObject({ invoiceId, attempts: 1 });
    expect(await h.runner.recoverExpired()).toBe(0); // lease still valid
    await h.veyra.db.update(t.jobs).set({ lockedAt: '2026-09-28T05:00:00.000Z' });
    expect(await h.veyra.jobStats(h.runner.leaseMs)).toMatchObject({ running: 1, expired: 1 });
    expect(await h.runner.recoverExpired()).toBe(1);
    expect((await h.veyra.latestJobs(invoiceId))[0]).toMatchObject({
      status: 'queued',
      attempts: 1,
    });
    await h.runner.drain();
    expect(await h.state(invoiceId)).toBe('VERIFIED_PENDING_PAYMENT');
    expect(await h.erp.listPurchaseInvoices()).toHaveLength(1);
    expect(await h.openQuestions(invoiceId)).toEqual([]);
  });

  it('an abandoned job that has used its attempts fails the invoice instead of looping', async () => {
    h = await createHarness();
    const { file, bytes } = S01();
    const { invoiceId } = await h.veyra.upload({ filename: file, bytes });
    await h.veyra.claimJob();
    await h.veyra.db.update(t.jobs).set({ attempts: 5, lockedAt: '2026-09-28T05:00:00.000Z' });
    await h.runner.recoverExpired();
    expect((await h.veyra.latestJobs(invoiceId))[0]).toMatchObject({
      status: 'failed',
      lastError: 'WORKER_LOST',
    });
    expect(await h.veyra.invoiceRow(h.veyra.db, invoiceId)).toMatchObject({
      state: 'FAILED',
      failureReason: 'Processing stopped repeatedly before it could finish.',
    });
  });

  it('a commit job whose worker died right after the ERP write is recovered without a second write', async () => {
    let crash = true;
    h = await createHarness({
      commitHooks: {
        afterErpWrite: (entity) => {
          if (entity === 'purchase_invoice' && crash) throw new CrashSignal('after the ERP write');
        },
      },
    });
    const { file, bytes } = S01();
    const { invoiceId } = await h.veyra.upload({ filename: file, bytes });
    await expect(h.runner.drain()).rejects.toThrow(CrashSignal); // the worker dies mid-commit
    const commit = async () =>
      (await h?.veyra.latestJobs(invoiceId))?.find((j) => j.type === 'commit');
    expect(await commit()).toMatchObject({ status: 'running' });
    expect(await h.erp.listPurchaseInvoices()).toHaveLength(1); // the ERP has the invoice
    expect(await h.state(invoiceId)).toBe('COMMITTING'); // Veyra has not recorded it yet
    crash = false;
    await h.veyra.db.update(t.jobs).set({ lockedAt: '2026-09-28T05:00:00.000Z' }); // lease expires
    expect(await h.runner.recoverExpired()).toBe(1);
    expect(await commit()).toMatchObject({ status: 'queued' });
    await h.runner.drain(); // claimed again
    expect(await commit()).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await h.state(invoiceId)).toBe('VERIFIED_PENDING_PAYMENT');
    expect(await h.erp.listPurchaseInvoices()).toHaveLength(1); // no duplicate ERP write
    expect(
      await h.veyra.db.select().from(t.erpWrites).where(eq(t.erpWrites.invoiceId, invoiceId)),
    ).toMatchObject([{ operation: 'recordPurchaseInvoice', status: 'confirmed' }]);
  });

  it('shutdown: the server stops, the worker claims nothing more, queued work stays queued', async () => {
    const app = await open();
    const { file, bytes } = S01();
    const { invoiceId } = await app.veyra.upload({ filename: file, bytes });
    app.runner.start(60_000);
    await app.runner.shutdown(1000);
    expect(await app.runner.step()).toBe(false); // no new claims after shutdown
    expect(app.runner.health()).toMatchObject({ running: false });
    await app.server.close();
    expect(app.server.server.listening).toBe(false);
    const job = (await app.veyra.latestJobs(invoiceId))[0];
    expect(['queued', 'succeeded']).toContain(job?.status); // never left running
  });

  it('graceful shutdown lets a running job finish, or puts it back in the queue — never stranded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'veyra-prod-'));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = new LocalDocumentStorage(join(dir, 'u'));
    const slow: DocumentStorage = Object.assign(Object.create(inner) as LocalDocumentStorage, {
      withLocalFile: async <T>(
        k: string,
        fn: (p: string) => Promise<T>,
        v?: { sha256: string },
      ) => {
        await gate;
        return inner.withLocalFile(k, fn, v);
      },
    });
    const app = await open({ storage: slow });
    const { file, bytes } = S01();
    const { invoiceId } = await app.veyra.upload({ filename: file, bytes });
    const running = app.runner.step();
    await new Promise((r) => setTimeout(r, 20));
    expect((await app.veyra.latestJobs(invoiceId))[0]).toMatchObject({ status: 'running' });
    await app.runner.shutdown(50); // the job does not finish in time
    expect((await app.veyra.latestJobs(invoiceId))[0]).toMatchObject({
      status: 'queued',
      lockedAt: null,
    });
    release();
    await running;
    rmSync(dir, { recursive: true, force: true });
  });
});
