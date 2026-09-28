import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { FakeErpConnector } from '@veyra/fake-erp';
import {
  DemoRoutedExtractor,
  FixtureExtractor,
  LocalDocumentExtractor,
  OllamaAssist,
  type Extractor,
} from '@veyra/extractor';
import { openVeyraDb } from './db/open';
import { buildServer } from './http/server';
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
  /** Tests only: replaces the real document extractor. */
  documentExtractor?: Extractor & { close?: () => Promise<void> };
  clock?: () => Date;
  logger?: boolean;
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
  const demo = (mode === 'demo' || mode === 'fixture') && config.nodeEnv !== 'production';
  if (!demo || !config.allowFixtureExtractor) return real;
  const fixture = new FixtureExtractor({
    allow: config.allowFixtureExtractor,
    nodeEnv: config.nodeEnv,
  });
  return Object.assign(new DemoRoutedExtractor(fixture, real), {
    close: () => real.close?.() ?? Promise.resolve(),
  });
}

/**
 * Composition root: the only place that knows the ERP is the fake ERP and which extractor reads
 * documents. Everything else sees the ErpConnector and Extractor ports.
 */
export async function createApp(config: AppConfig) {
  mkdirSync(config.dataDir, { recursive: true });
  const { sqlite, db } = openVeyraDb(join(config.dataDir, 'veyra.db'));
  const erp = FakeErpConnector.open({
    filename: join(config.dataDir, 'fake_erp.db'),
    ...(config.clock ? { clock: config.clock } : {}),
  });
  const initialSettings = config.demo ? DEMO_SETTINGS : DEFAULT_SETTINGS;
  const storageDir = join(config.dataDir, 'uploads');
  const extractor = makeExtractor(initialSettings.extractorMode, config);
  const veyra = new Veyra({
    db,
    erp,
    extractor,
    storageDir,
    initialSettings,
    ...(config.clock ? { clock: config.clock } : {}),
  });
  // A fresh ERP file gets the DEMO.md seed.
  if ((await erp.listVendors()).length === 0 && config.demo) erp.reset('demo');
  const runner = new JobRunner(veyra);

  const resetDemo = async (mode: 'demo' | 'empty' = 'demo') => {
    runner.stop();
    erp.reset(mode === 'empty' ? 'company-only' : 'demo');
    db.transaction((tx) => {
      for (const table of [
        'imports',
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
    rmSync(storageDir, { recursive: true, force: true });
    mkdirSync(storageDir, { recursive: true });
    runner.start();
  };

  const server = await buildServer({
    veyra,
    ...(config.demo ? { resetDemo } : {}),
    logger: config.logger ?? false,
  });
  return {
    veyra,
    runner,
    server,
    close: async () => {
      runner.stop();
      await server.close();
      sqlite.close();
      erp.close();
      await extractor.close?.();
    },
  };
}
