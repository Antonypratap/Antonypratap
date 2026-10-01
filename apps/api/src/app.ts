import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { guardCapabilities, type ErpConnector } from '@veyra/erp-connector';
import { FakeErpConnector, type FakeErpBusiness } from '@veyra/fake-erp';
import {
  DemoRoutedExtractor,
  FixtureExtractor,
  GeminiExtractor,
  LocalDocumentExtractor,
  OllamaAssist,
  TesseractOcr,
  type Extractor,
} from '@veyra/extractor';
import { configureDocumentLimits, type ConfigurableDocumentLimits } from '@veyra/extractor';
import type { Environment } from './config';
import { openVeyraDb } from './db/open';
import * as t from './db/schema';
import { readinessCheck } from './http/health';
import type { RateBucket } from './http/rate-limit';
import { buildServer } from './http/server';
import { sessionCookieName } from './http/access';
import { LocalDocumentStorage, type DocumentStorage } from './storage';
import { SessionStore } from './auth/sessions';
import { timedErp, timedOcr } from './perf/timing';
import { Users } from './auth/users';
import { CommercialAdmin } from './commercial/admin';
import type { Secret } from './secret';
import { JobRunner } from './workflow/runner';
import type { WebFiles } from './http/web-static';
import { DEFAULT_SETTINGS, DEMO_SETTINGS, Veyra } from './workflow/veyra';

export interface AppConfig {
  dataDir: string;
  /** Seed demo settings (automatic POs below ₹25,000) and allow resetting the demo. */
  demo: boolean;
  /**
   * The demo's sample business (docs/DEMO.md): its ERP seed and its scenario documents. Default
   * `manufacturing`, the test suite's seed; deployments take VEYRA_DEMO_BUSINESS (default brewery).
   */
  demoBusiness?: FakeErpBusiness;
  allowFixtureExtractor: boolean;
  nodeEnv: string | undefined;
  /** Optional local Ollama assist (VEYRA_OLLAMA_URL / VEYRA_OLLAMA_MODEL). Off when absent. */
  ollama?: { baseUrl: string; model: string } | null;
  /** The AI vision reader (Gemini); the local reader stays as its fallback. Off when absent. */
  ai?: { apiKey: string; model: string; fetch?: typeof fetch } | null;
  /** Tests only: wraps the ERP connector (e.g. the scripted connector that injects failures). */
  wrapErp?: (erp: ErpConnector) => ErpConnector;
  /** Tests only: replaces the real document extractor. */
  documentExtractor?: Extractor & { close?: () => Promise<void> };
  clock?: () => Date;
  /** Phase 6: the deployment. Defaults to production when NODE_ENV is, else development. */
  environment?: Environment;
  /** Document storage. Defaults to `<dataDir>/uploads` on the local filesystem. */
  storage?: DocumentStorage;
  /** Apply pending migrations on open (default true; production runs `db:migrate` instead). */
  migrate?: boolean;
  /**
   * The Veyra application database (PostgreSQL). `url` is required outside development; without
   * it, development uses the embedded engine in `<dataDir>/pgdata`. Tests always pass a URL.
   */
  database?: {
    url?: string | null;
    pool?: { max?: number; connectTimeoutMs?: number; statementTimeoutMs?: number };
  };
  /** Structured logger; absent: silent. */
  log?: Logger;
  limits?: { maxUploadBytes: number; maxJsonBodyBytes: number } & ConfigurableDocumentLimits;
  rateLimits?: Record<RateBucket, number>;
  trustProxy?: number;
  jobs?: { leaseMs: number; shutdownGraceMs: number };
  /** The organization this deployment serves (Phase 6C). */
  organizationName?: string;
  /** The built web app, served from the API's own origin (production client instances). */
  web?: WebFiles | null;
  /** The deployed commit (RAILWAY_GIT_COMMIT_SHA), shown by GET /api/v1/health. */
  release?: string | null;
  /**
   * Sign-in (Phase 6C). Defaults suit development and tests only: 30 min idle, 12 h absolute,
   * cookie not Secure (plain http on localhost), the Vite dev origins.
   */
  auth?: {
    session?: { idleMs: number; absoluteMs: number };
    cookieSecure?: boolean;
    demoPin?: Secret | null;
    publicOrigins?: readonly string[];
    corsOrigins?: readonly string[];
  };
}

const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * The real, local document extractor reads every document. In the demo (never in production), the
 * demo's own sample invoices keep their scripted reading so the DEMO.md scenarios stay exact.
 */
function makeExtractor(
  mode: string,
  config: AppConfig,
): { extractor: Extractor & { close?: () => Promise<void> }; warmUp: () => Promise<void> } {
  const local = config.documentExtractor
    ? null
    : new LocalDocumentExtractor({
        ollama: config.ollama ? new OllamaAssist(config.ollama) : null,
        // OCR is timed on its own (docs/PERFORMANCE.md); the engine is unchanged.
        ocr: timedOcr(new TesseractOcr()),
      });
  const warmUp = () => (local ? local.warmUp({ ocr: true }) : Promise.resolve());
  const base: Extractor & { close?: () => Promise<void> } =
    config.documentExtractor ?? (local as LocalDocumentExtractor);
  // The AI reader reads first; the local reader is its fallback (and closes with it).
  const real: Extractor & { close?: () => Promise<void> } = config.ai
    ? Object.assign(
        new GeminiExtractor({
          apiKey: config.ai.apiKey,
          model: config.ai.model,
          fallback: base,
          ...(config.ai.fetch ? { fetch: config.ai.fetch } : {}),
        }),
        { close: () => base.close?.() ?? Promise.resolve() },
      )
    : base;
  const environment = environmentOf(config);
  const demo = (mode === 'demo' || mode === 'fixture') && environment !== 'production';
  if (!demo || !config.allowFixtureExtractor) return { extractor: real, warmUp };
  const fixture = new FixtureExtractor({
    allow: config.allowFixtureExtractor,
    nodeEnv: environment,
  });
  return {
    extractor: Object.assign(new DemoRoutedExtractor(fixture, real), {
      close: () => real.close?.() ?? Promise.resolve(),
    }),
    warmUp,
  };
}

/**
 * Composition root: the only place that knows the ERP is the fake ERP and which extractor reads
 * documents. Everything else sees the ErpConnector and Extractor ports.
 */
function environmentOf(config: AppConfig): Environment {
  return config.environment ?? (config.nodeEnv === 'production' ? 'production' : 'development');
}

export async function createApp(config: AppConfig) {
  const environment = environmentOf(config);
  // Production never runs the demo, whatever the caller says (config validation refuses it too).
  const demoMode = config.demo && environment !== 'production';
  if (config.limits) configureDocumentLimits(config.limits);
  mkdirSync(config.dataDir, { recursive: true });
  const url = config.database?.url ?? null;
  if (!url && environment !== 'development')
    throw new Error('The Veyrafy database URL (DATABASE_URL) is required outside development.');
  if (!url && process.env.VITEST)
    throw new Error('Tests run against PostgreSQL: pass a database URL (see TEST_DATABASE_URL).');
  const database = await openVeyraDb({
    url,
    pgliteDir: join(config.dataDir, 'pgdata'),
    migrate: config.migrate ?? true,
    ...(config.database?.pool ? { pool: config.database.pool } : {}),
  });
  const db = database.db;
  const demoBusiness = config.demoBusiness ?? 'manufacturing';
  const erp = FakeErpConnector.open({
    filename: join(config.dataDir, 'fake_erp.db'),
    business: demoBusiness,
    ...(config.clock ? { clock: config.clock } : {}),
  });
  const initialSettings = demoMode ? DEMO_SETTINGS : DEFAULT_SETTINGS;
  const storage = config.storage ?? new LocalDocumentStorage(join(config.dataDir, 'uploads'));
  const { extractor, warmUp: warmUpExtractor } = makeExtractor(
    initialSettings.extractorMode,
    config,
  );
  // The workflow sees only the ErpConnector port, behind the capability guard: an operation the
  // connector does not declare is UNSUPPORTED, never a silent fallback (ARCHITECTURE §17).
  // Every connector call is timed (ERP_LOOKUP / ERP_WRITE) without changing the contract.
  const connector = guardCapabilities(timedErp(config.wrapErp ? config.wrapErp(erp) : erp));
  const veyra = new Veyra({
    db,
    erp: connector,
    extractor,
    storage,
    ...(config.limits ? { maxUploadBytes: config.limits.maxUploadBytes } : {}),
    initialSettings,
    ...(config.clock ? { clock: config.clock } : {}),
    ...(config.organizationName ? { organizationName: config.organizationName } : {}),
  });
  await veyra.init();
  const sessions = new SessionStore(
    db,
    config.auth?.session ?? { idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 },
    config.clock,
  );
  const users = new Users(db, sessions, veyra.organizationId, config.clock, veyra.entitlements);
  // Veyra Operations' commercial actions (Phase 8A), on the same entitlement service and cache.
  const commercial = new CommercialAdmin(db, veyra.entitlements, veyra.clock);
  // A fresh ERP file gets the DEMO.md seed.
  if ((await erp.listVendors()).length === 0 && demoMode) erp.reset('demo');
  const runner = new JobRunner(veyra, {
    ...(config.log ? { logger: config.log.child({ component: 'jobs' }) } : {}),
    ...(config.jobs ? { leaseMs: config.jobs.leaseMs } : {}),
  });
  if (config.log) {
    const log = config.log;
    veyra.onInternalError = (err, context) =>
      log.error({ ...context, err }, 'invoice failed on an internal error');
  }

  // Demo only (never registered in production): wipe Veyra's data and its stored documents.
  const resetDemo = async (mode: 'demo' | 'empty' = 'demo') => {
    await runner.shutdown(10_000);
    erp.reset(mode === 'empty' ? 'company-only' : 'demo');
    const keys = [
      ...(await db.select().from(t.documents)).map((d) => veyra.documentKey(d)),
      ...(
        await db.select({ filesJson: t.imports.filesJson, id: t.imports.id }).from(t.imports)
      ).flatMap((i) =>
        (JSON.parse(i.filesJson) as { key?: string; path?: string }[]).map(
          (f) => f.key ?? `imports/${i.id}/${(f.path ?? '').split(/[\\/]/).pop() ?? ''}`,
        ),
      ),
    ];
    for (const key of keys) await storage.delete(key).catch(() => undefined);
    await db.transaction(async (tx) => {
      for (const table of [
        'imports',
        'erp_writes',
        'jobs',
        'audit_events',
        'questions',
        'validation_results',
        'creation_actions',
        'match_results',
        'invoice_lines',
        'extracted_fields',
        'extractions',
        'invoices',
        'documents',
      ]) {
        await tx.execute(sql.raw(`DELETE FROM ${table}`));
      }
    });
    runner.start();
  };

  const cookieSecure = config.auth?.cookieSecure ?? environment !== 'development';
  const server = await buildServer({
    veyra,
    environment,
    commercial,
    ...(demoMode ? { resetDemo, demoBusiness } : {}),
    ...(config.log ? { log: config.log } : {}),
    ...(config.limits ? { limits: config.limits } : {}),
    ...(config.rateLimits ? { rateLimits: config.rateLimits } : {}),
    ...(config.trustProxy !== undefined ? { trustProxy: config.trustProxy } : {}),
    web: config.web ?? null,
    release: config.release ?? null,
    auth: {
      sessions,
      users,
      cookieSecure,
      // The demo sign-in exists only in demo mode, never in production.
      demoPin: demoMode ? (config.auth?.demoPin ?? null) : null,
      publicOrigins: config.auth?.publicOrigins ?? DEV_ORIGINS,
      corsOrigins: config.auth?.corsOrigins ?? [],
    },
    readiness: readinessCheck({
      veyra,
      storage,
      runner,
      pingDatabase: database.ping,
      poolStats: database.poolStats,
      environment,
      expectWorker: true,
    }),
  });
  let closed: Promise<void> | null = null;
  return {
    veyra,
    runner,
    server,
    storage,
    sessions,
    users,
    commercial,
    /** The session cookie's name (it depends on whether it is Secure). */
    cookieName: sessionCookieName(cookieSecure),
    environment,
    database,
    /**
     * Loads the PDF reader and starts the OCR engine now (Phase 7), so the first invoice after a
     * start is not slower than the rest. The server calls it before taking traffic; tests do not.
     */
    warmUp: warmUpExtractor,
    /**
     * Graceful shutdown: stop taking requests (in-flight ones finish), let the current job finish
     * or put it back in the queue, then close the database, the ERP and the document readers.
     */
    close: (graceMs = config.jobs?.shutdownGraceMs ?? 25_000) =>
      (closed ??= (async () => {
        await server.close();
        await runner.shutdown(graceMs);
        await database.close();
        erp.close();
        await extractor.close?.();
      })()),
  };
}
