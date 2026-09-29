import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { inArray } from 'drizzle-orm';
import { Writable } from 'node:stream';
import type { ErpConnector } from '@veyra/erp-connector';
import { createLogger } from '../src/http/logging';
import { createApp, type AppConfig } from '../src/app';
import * as t from '../src/db/schema';
import { createTestDatabase, type TestDatabase } from '../src/test/database';
import { testSession, type TestSession } from '../src/test/auth';

/**
 * Benchmark helpers (Phase 7, docs/PERFORMANCE.md). Everything here drives the real application
 * from the outside: real PostgreSQL (TEST_DATABASE_URL), real HTTP on a local port, the real
 * extractor. Hooks that exist for tests (wrapErp) are used to time ERP calls without changing
 * production code. Never run against production data.
 */

export interface Stats {
  n: number;
  errors: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  /** Operations per second over the measured wall time (when given). */
  throughput?: number;
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Nearest-rank percentiles over durations in milliseconds. */
export function stats(samples: number[], errors = 0, wallMs?: number): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const pct = (p: number) =>
    s.length ? (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0) : 0;
  return {
    n: s.length,
    errors,
    min: round(s[0] ?? 0),
    p50: round(pct(50)),
    p95: round(pct(95)),
    p99: round(pct(99)),
    max: round(s[s.length - 1] ?? 0),
    mean: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
    ...(wallMs ? { throughput: round(((s.length + errors) * 1000) / wallMs) } : {}),
  };
}

export const now = () => performance.now();

/** Records every ERP connector call by operation (wraps the connector from the outside). */
export class ErpTimer {
  readonly calls = new Map<string, number[]>();
  wrap = (erp: ErpConnector): ErpConnector =>
    new Proxy(erp, {
      get: (target, prop, receiver) => {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || typeof prop !== 'string') return value;
        return (...args: unknown[]) => {
          const started = now();
          const result: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (result instanceof Promise)
            return result.finally(() => this.#add(prop, now() - started));
          this.#add(prop, now() - started);
          return result;
        };
      },
    });
  #add(op: string, ms: number) {
    const list = this.calls.get(op) ?? [];
    list.push(ms);
    this.calls.set(op, list);
  }
  reset() {
    this.calls.clear();
  }
  summary() {
    return Object.fromEntries(
      [...this.calls.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([op, list]) => [
          op,
          { ...stats(list), totalMs: round(list.reduce((a, b) => a + b, 0)) },
        ]),
    );
  }
}

export interface BenchApp {
  app: Awaited<ReturnType<typeof createApp>>;
  database: TestDatabase;
  dir: string;
  base: string;
  session: TestSession;
  erp: ErpTimer;
  /** Structured log lines the app wrote (info level): job outcomes with their stage timings. */
  logLines: Record<string, unknown>[];
  /** Per-stage statistics over the jobs logged so far (instrumented builds only). */
  stageStats: () => Record<string, Stats>;
  close: () => Promise<void>;
}

/**
 * A Veyra instance for benchmarking: its own database, the demo ERP seed, the REAL document
 * extractor (no fixture readings), rate limits raised so the benchmark measures Veyra rather than
 * the limiter, a worker loop running as in production, and an HTTP listener.
 */
export async function benchApp(extra: Partial<AppConfig> = {}): Promise<BenchApp> {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-bench-'));
  const database = await createTestDatabase();
  const erp = new ErpTimer();
  const logLines: Record<string, unknown>[] = [];
  const log = createLogger(
    { level: 'info', environment: 'development' },
    new Writable({
      write(chunk: Buffer, _enc, done) {
        for (const l of chunk.toString().split('\n').filter(Boolean))
          logLines.push(JSON.parse(l) as Record<string, unknown>);
        done();
      },
    }),
  );
  const app = await createApp({
    log,
    dataDir: dir,
    demo: true, // the DEMO.md ERP seed (vendors, items, POs, GRNs)
    allowFixtureExtractor: false, // every document is read by the real local extractor
    nodeEnv: 'test',
    database: { url: database.url, pool: { max: 10 } },
    rateLimits: { upload: 100_000, processing: 100_000, dev: 100_000, login: 100_000 },
    wrapErp: erp.wrap,
    ...extra,
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.server.address() as AddressInfo).port;
  app.runner.start();
  const session = await testSession(app);
  return {
    app,
    database,
    dir,
    base: `http://127.0.0.1:${port}/api/v1`,
    session,
    erp,
    logLines,
    stageStats: () => {
      const per = new Map<string, number[]>();
      for (const l of logLines) {
        const stages = l.stages as Record<string, { ms: number }> | undefined;
        if (l.msg !== 'job succeeded' || !stages) continue;
        for (const [k, v] of Object.entries(stages)) per.set(k, [...(per.get(k) ?? []), v.ms]);
      }
      return Object.fromEntries([...per.entries()].map(([k, v]) => [k, stats(v)]));
    },
    close: async () => {
      await app.close(5_000);
      await database.drop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One HTTP request with the session; returns duration, status and body size. */
export async function call(
  b: BenchApp,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ms: number; status: number; bytes: number; json: unknown }> {
  const started = now();
  const res = await fetch(`${b.base}${path}`, {
    method,
    headers: {
      ...b.session.headers,
      ...(body instanceof FormData
        ? {}
        : body !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  const ms = now() - started;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (a document)
  }
  return { ms, status: res.status, bytes: Buffer.byteLength(text), json };
}

export async function upload(b: BenchApp, filename: string, bytes: Uint8Array, mime: string) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), filename);
  return call(b, 'POST', '/documents', form);
}

/** States where the workflow has stopped: done, waiting for a person, or failed. */
export const SETTLED = ['NEEDS_INPUT', 'VERIFIED_PENDING_PAYMENT', 'FAILED', 'REJECTED'];

/** Waits until every given invoice has settled; returns when each settled (ms since `from`). */
export async function waitSettled(
  b: BenchApp,
  invoiceIds: string[],
  from: number,
  timeoutMs = 600_000,
): Promise<Map<string, { ms: number; state: string }>> {
  const done = new Map<string, { ms: number; state: string }>();
  const deadline = now() + timeoutMs;
  while (done.size < invoiceIds.length) {
    const pending = invoiceIds.filter((id) => !done.has(id));
    const rows = await b.app.veyra.db
      .select({ id: t.invoices.id, state: t.invoices.state })
      .from(t.invoices)
      .where(inArray(t.invoices.id, pending));
    for (const r of rows)
      if (SETTLED.includes(r.state)) done.set(r.id, { ms: now() - from, state: r.state });
    if (done.size < invoiceIds.length) {
      if (now() > deadline) throw new Error(`not settled: ${pending.length}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return done;
}

export const count = <T extends string>(list: T[]) =>
  list.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});

export const mb = (bytes: number) => round(bytes / 1024 / 1024);
