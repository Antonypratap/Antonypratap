import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { FakeErpConnector } from '@veyra/fake-erp';
import { FixtureExtractor, type Extractor } from '@veyra/extractor';
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
  clock?: () => Date;
  logger?: boolean;
}

/** Only the fixture extractor exists in this slice; anything else is refused, never faked. */
function makeExtractor(mode: string, config: AppConfig): Extractor {
  if (mode === 'fixture')
    return new FixtureExtractor({ allow: config.allowFixtureExtractor, nodeEnv: config.nodeEnv });
  throw new Error(
    `Extractor "${mode}" is not available in this version. Use the demo (fixture) extractor.`,
  );
}

/**
 * Composition root: the only place that knows the ERP is the fake ERP and the extractor is the
 * fixture extractor. Everything else sees the ErpConnector and Extractor ports.
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
  const veyra = new Veyra({
    db,
    erp,
    extractor: makeExtractor(initialSettings.extractorMode, config),
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
    },
  };
}
