import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { guardCapabilities, type ErpConnector } from '@veyra/erp-connector';
import { FakeErpConnector, type FakeErpTestHooks } from '@veyra/fake-erp';
import { FixtureExtractor, renderScenario, scenarioById } from '@veyra/extractor';
import { openVeyraDb, type VeyraDatabase } from '../db/open';
import * as t from '../db/schema';
import { LocalDocumentStorage } from '../storage';
import { JobRunner } from '../workflow/runner';
import { DEMO_SETTINGS, DEMO_USER, Veyra, type VeyraOptions } from '../workflow/veyra';
import { createTestDatabase, type TestDatabase } from './database';

/** The demo's fixed "today" (DEMO.md): 28 Sep 2026, midday in India. */
export const DEMO_NOW = new Date('2026-09-28T06:30:00.000Z');

export interface Harness {
  dir: string;
  /** The test's own PostgreSQL database. */
  database: TestDatabase;
  veyra: Veyra;
  runner: JobRunner;
  erp: FakeErpConnector;
  upload: (scenarioId: string) => Promise<string>;
  state: (invoiceId: string) => Promise<string>;
  openQuestions: (
    invoiceId: string,
  ) => Promise<
    { id: string; code: string; subjectKey: string; options: { id: string; label: string }[] }[]
  >;
  answer: (invoiceId: string, code: string, optionId: string, input?: unknown) => Promise<void>;
  /** Simulates a restart: new connections (pool, ERP file) over the same database and files. */
  restart: (opts?: {
    erpHooks?: FakeErpTestHooks;
    commitHooks?: VeyraOptions['commitHooks'];
    wrapErp?: (erp: FakeErpConnector) => ErpConnector;
  }) => Promise<Harness>;
  /** Closes connections; with `remove` (default) also drops the database and deletes the files. */
  close: (remove?: boolean) => Promise<void>;
}

export async function createHarness(
  opts: {
    dir?: string;
    database?: TestDatabase;
    seedErp?: boolean;
    erpHooks?: FakeErpTestHooks;
    commitHooks?: VeyraOptions['commitHooks'];
    /** Wraps the fake ERP (e.g. with the scripted test connector). Always behind the guard. */
    wrapErp?: (erp: FakeErpConnector) => ErpConnector;
  } = {},
): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'veyra-'));
  const database = opts.database ?? (await createTestDatabase());
  const erp = FakeErpConnector.open({
    filename: join(dir, 'fake_erp.db'),
    ...(opts.seedErp === false ? {} : { reset: 'demo' as const }),
    clock: () => DEMO_NOW,
    ...(opts.erpHooks ? { testHooks: opts.erpHooks } : {}),
  });
  const pg: VeyraDatabase = await openVeyraDb({
    url: database.url,
    migrate: false,
    pool: { max: 4 },
  });
  const db = pg.db;
  const veyra = await new Veyra({
    db,
    erp: guardCapabilities(opts.wrapErp ? opts.wrapErp(erp) : erp),
    extractor: new FixtureExtractor({ allow: true, nodeEnv: 'test' }),
    storage: new LocalDocumentStorage(join(dir, 'uploads')),
    clock: () => DEMO_NOW,
    initialSettings: DEMO_SETTINGS,
    ...(opts.commitHooks ? { commitHooks: opts.commitHooks } : {}),
  }).init();
  const runner = new JobRunner(veyra);
  const openQuestions: Harness['openQuestions'] = async (invoiceId) =>
    (
      await db
        .select()
        .from(t.questions)
        .where(and(eq(t.questions.invoiceId, invoiceId), eq(t.questions.status, 'open')))
        .orderBy(asc(t.questions.seq))
    ).map((q) => ({
      id: q.id,
      code: q.code,
      subjectKey: q.subjectKey,
      options: JSON.parse(q.optionsJson) as { id: string; label: string }[],
    }));
  const h: Harness = {
    dir,
    database,
    veyra,
    runner,
    erp,
    async upload(id) {
      const s = scenarioById(id);
      if (!s) throw new Error(`unknown scenario ${id}`);
      const { invoiceId } = await veyra.upload({ filename: s.file, bytes: renderScenario(s) });
      await runner.drain();
      return invoiceId;
    },
    state: async (invoiceId) => (await veyra.invoiceRow(db, invoiceId)).state,
    openQuestions,
    async answer(invoiceId, code, optionId, input) {
      const open = await openQuestions(invoiceId);
      const q = open.find((x) => x.code === code);
      if (!q) throw new Error(`no open ${code}; open: ${open.map((x) => x.code).join(', ')}`);
      await veyra.answer(q.id, { optionId, input: input ?? null }, DEMO_USER.id);
      await runner.drain();
    },
    async restart(next = {}) {
      await h.close(false);
      return createHarness({ dir, database, seedErp: false, ...next });
    },
    async close(remove = true) {
      runner.stop();
      await pg.close();
      erp.close();
      if (remove) {
        await database.drop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
  return h;
}
