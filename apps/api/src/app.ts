import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { guardCapabilities, type ErpConnector } from '@veyra/erp-connector';
import { FakeErpConnector } from '@veyra/fake-erp';
import {
  DemoRoutedExtractor,
  FixtureExtractor,
  LocalDocumentExtractor,
  OllamaAssist,
  type Extractor,
} from '@veyra/extractor';
import { configureDocumentLimits, type ConfigurableDocumentLimits } from '@veyra/extractor';
import type { Environment } from './config';
import { openVeyraDb } from './db/open';
import * as t from './db/schema';
import { readinessCheck } from './http/health';
import type { RateBucket } from './http/rate-limit';
import { buildServer } from './http/server';
import { LocalDocumentStorage, type DocumentStorage } from './storage';
import { JobRunner } from './workflow/runner';
import { DEFAULT_SETTINGS, DEMO_SETTINGS, Veyra } from './workflow/veyra';

export interface AppConfig {
  dataDir: string;
  /** Seed demo settings (automatic POs below ₹25,000) and allow resetting the demo. */
  demo: boolean;
  allowFixtureExtractor: boolean;
  nodeEnv: string | undefined;
  /** Optional local Ollama assist (VEYRA_OLLAMA_URL / VEYRA_OLLAMA_MODEL). Off when absent. */
  ollama?: { baseUrl: string; model: string } | null;
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
  /** Structured logger; absent: silent. */
  log?: Logger;
  limits?: { maxUploadBytes: number; maxJsonBodyBytes: number } & ConfigurableDocumentLimits;
  rateLimits?: Record<RateBucket, number>;
  trustProxy?: number;
  jobs?: { leaseMs: number; shutdownGraceMs: number };
}

/**
 * The real, local document extractor reads every document. In the demo (never in production), the
 * demo's own sample invoices keep their scripted reading so the DEMO.md scenarios stay exact.
 */
function makeExtractor(
  mode: string,
  config: AppConfig,
): Extractor & { close?: () => Promise<void> } {
  const real =
    config.documentExtractor ??
    new LocalDocumentExtractor({
      ollama: config.ollama ? new OllamaAssist(config.ollama) : null,
    });
  const environment = environmentOf(config);
  const demo = (mode === 'demo' || mode === 'fixture') && environment !== 'production';
  if (!demo || !config.allowFixtureExtractor) return real;
  const fixture = new FixtureExtractor({
    allow: config.allowFixtureExtractor,
    nodeEnv: environment,
  });
  return Object.assign(new DemoRoutedExtractor(fixture, real), {
    close: () => real.close?.() ?? Promise.resolve(),
  });
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
  const { sqlite, db } = openVeyraDb(join(config.dataDir, 'veyra.db'), {
    migrate: config.migrate ?? true,
  });
  const erp = FakeErpConnector.open({
    filename: join(config.dataDir, 'fake_erp.db'),
    ...(config.clock ? { clock: config.clock } : {}),
  });
  const initialSettings = demoMode ? DEMO_SETTINGS : DEFAULT_SETTINGS;
  const storage = config.storage ?? new LocalDocumentStorage(join(config.dataDir, 'uploads'));
  const extractor = makeExtractor(initialSettings.extractorMode, config);
  // The workflow sees only the ErpConnector port, behind the capability guard: an operation the
  // connector does not declare is UNSUPPORTED, never a silent fallback (ARCHITECTURE §17).
  const connector = guardCapabilities(config.wrapErp ? config.wrapErp(erp) : erp);
  const veyra = new Veyra({
    db,
    erp: connector,
    extractor,
    storage,
    ...(config.limits ? { maxUploadBytes: config.limits.maxUploadBytes } : {}),
    initialSettings,
    ...(config.clock ? { clock: config.clock } : {}),
  });
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
    runner.stop();
    erp.reset(mode === 'empty' ? 'company-only' : 'demo');
    const keys = [
      ...db
        .select()
        .from(t.documents)
        .all()
        .map((d) => veyra.documentKey(d)),
      ...db
        .select({ filesJson: t.imports.filesJson, id: t.imports.id })
        .from(t.imports)
        .all()
        .flatMap((i) =>
          (JSON.parse(i.filesJson) as { key?: string; path?: string }[]).map(
            (f) => f.key ?? `imports/${i.id}/${(f.path ?? '').split(/[\\/]/).pop() ?? ''}`,
          ),
        ),
    ];
    for (const key of keys) await storage.delete(key).catch(() => undefined);
    db.transaction((tx) => {
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
        tx.run(sql.raw(`DELETE FROM ${table}`));
      }
    });
    runner.start();
  };

  const server = await buildServer({
    veyra,
    environment,
    ...(demoMode ? { resetDemo } : {}),
    ...(config.log ? { log: config.log } : {}),
    ...(config.limits ? { limits: config.limits } : {}),
    ...(config.rateLimits ? { rateLimits: config.rateLimits } : {}),
    ...(config.trustProxy !== undefined ? { trustProxy: config.trustProxy } : {}),
    readiness: readinessCheck({ veyra, storage, runner, environment, expectWorker: true }),
  });
  let closed: Promise<void> | null = null;
  return {
    veyra,
    runner,
    server,
    storage,
    environment,
    /**
     * Graceful shutdown: stop taking requests (in-flight ones finish), let the current job finish
     * or put it back in the queue, then close the database, the ERP and the document readers.
     */
    close: (graceMs = config.jobs?.shutdownGraceMs ?? 25_000) =>
      (closed ??= (async () => {
        await server.close();
        await runner.shutdown(graceMs);
        sqlite.close();
        erp.close();
        await extractor.close?.();
      })()),
  };
}
