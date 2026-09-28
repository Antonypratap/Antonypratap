import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { guardCapabilities, type ErpConnector } from '@veyra/erp-connector';
import { FakeErpConnector, type FakeErpTestHooks } from '@veyra/fake-erp';
import { FixtureExtractor, renderScenario, scenarioById } from '@veyra/extractor';
import { openVeyraDb } from '../db/open';
import * as t from '../db/schema';
import { LocalDocumentStorage } from '../storage';
import { JobRunner } from '../workflow/runner';
import { DEMO_SETTINGS, DEMO_USER, Veyra, type VeyraOptions } from '../workflow/veyra';

/** The demo's fixed "today" (DEMO.md): 28 Sep 2026, midday in India. */
export const DEMO_NOW = new Date('2026-09-28T06:30:00.000Z');

export interface Harness {
  dir: string;
  veyra: Veyra;
  runner: JobRunner;
  erp: FakeErpConnector;
  upload: (scenarioId: string) => Promise<string>;
  state: (invoiceId: string) => string;
  openQuestions: (
    invoiceId: string,
  ) => { id: string; code: string; subjectKey: string; options: { id: string; label: string }[] }[];
  answer: (invoiceId: string, code: string, optionId: string, input?: unknown) => Promise<void>;
  /** Simulates a restart: new connections over the same files. */
  restart: (opts?: {
    erpHooks?: FakeErpTestHooks;
    commitHooks?: VeyraOptions['commitHooks'];
    wrapErp?: (erp: FakeErpConnector) => ErpConnector;
  }) => Harness;
  close: (remove?: boolean) => void;
}

export function createHarness(
  opts: {
    dir?: string;
    seedErp?: boolean;
    erpHooks?: FakeErpTestHooks;
    commitHooks?: VeyraOptions['commitHooks'];
    /** Wraps the fake ERP (e.g. with the scripted test connector). Always behind the guard. */
    wrapErp?: (erp: FakeErpConnector) => ErpConnector;
  } = {},
): Harness {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'veyra-'));
  const erp = FakeErpConnector.open({
    filename: join(dir, 'fake_erp.db'),
    ...(opts.seedErp === false ? {} : { reset: 'demo' as const }),
    clock: () => DEMO_NOW,
    ...(opts.erpHooks ? { testHooks: opts.erpHooks } : {}),
  });
  const { sqlite, db } = openVeyraDb(join(dir, 'veyra.db'));
  const veyra = new Veyra({
    db,
    erp: guardCapabilities(opts.wrapErp ? opts.wrapErp(erp) : erp),
    extractor: new FixtureExtractor({ allow: true, nodeEnv: 'test' }),
    storage: new LocalDocumentStorage(join(dir, 'uploads')),
    clock: () => DEMO_NOW,
    initialSettings: DEMO_SETTINGS,
    ...(opts.commitHooks ? { commitHooks: opts.commitHooks } : {}),
  });
  const runner = new JobRunner(veyra);
  const openQuestions: Harness['openQuestions'] = (invoiceId) =>
    db
      .select()
      .from(t.questions)
      .where(eq(t.questions.invoiceId, invoiceId))
      .all()
      .filter((q) => q.status === 'open')
      .map((q) => ({
        id: q.id,
        code: q.code,
        subjectKey: q.subjectKey,
        options: JSON.parse(q.optionsJson),
      }));
  const h: Harness = {
    dir,
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
    state: (invoiceId) => veyra.invoiceRow(db, invoiceId).state,
    openQuestions,
    async answer(invoiceId, code, optionId, input) {
      const q = openQuestions(invoiceId).find((x) => x.code === code);
      if (!q)
        throw new Error(
          `no open ${code}; open: ${openQuestions(invoiceId)
            .map((x) => x.code)
            .join(', ')}`,
        );
      veyra.answer(q.id, { optionId, input: input ?? null }, DEMO_USER.id);
      await runner.drain();
    },
    restart(next = {}) {
      h.close(false);
      return createHarness({ dir, seedErp: false, ...next });
    },
    close(remove = true) {
      sqlite.close();
      erp.close();
      if (remove) rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}
