import { afterEach, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { renderScenario, scenarioById } from '@veyra/extractor';
import {
  CreationActionIdSchema,
  InvoiceIdSchema,
  creationIdempotencyKey,
  purchaseInvoiceIdempotencyKey,
} from '@veyra/shared';
import { isErpConnectorError } from '@veyra/erp-connector';
import { openVeyraDb, rowsOf, type VeyraDatabase } from './open';
import * as t from './schema';
import { createTestDatabase, type TestDatabase } from '../test/database';
import { createHarness, type Harness } from '../test/harness';
import { Presenter } from '../http/present';
import { JobRunner } from '../workflow/runner';
import { DEMO_SETTINGS, DEMO_USER, Veyra, VeyraError } from '../workflow/veyra';

/**
 * Phase 6A: the Veyra application database on PostgreSQL. Schema and migrations, constraints,
 * timestamps, audit order, transactions, and what SQLite's single writer used to guarantee and
 * PostgreSQL must now guarantee explicitly: concurrent workers and requests.
 */
/** The value, or a test failure naming what was missing. */
function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function database(): Promise<TestDatabase> {
  const d = await createTestDatabase();
  cleanup.push(() => d.drop());
  return d;
}
async function connect(d: TestDatabase, max = 4): Promise<VeyraDatabase> {
  const c = await openVeyraDb({ url: d.url, migrate: false, pool: { max } });
  cleanup.push(() => c.close());
  return c;
}
async function harness(): Promise<Harness> {
  const h = await createHarness();
  cleanup.push(() => h.close());
  return h;
}
const S = (id: string) => {
  const s = scenarioById(id);
  if (!s) throw new Error(id);
  return { filename: s.file, bytes: renderScenario(s) };
};
const q = async <T>(c: VeyraDatabase, query: ReturnType<typeof sql>) =>
  rowsOf<T>(await c.db.execute(query));

const TABLES: PgTable[] = [
  t.organizations,
  t.users,
  t.sessions,
  t.securityEvents,
  t.settings,
  t.documents,
  t.invoices,
  t.extractions,
  t.extractedFields,
  t.invoiceLines,
  t.matchResults,
  t.creationActions,
  t.validationResults,
  t.questions,
  t.erpWrites,
  t.auditEvents,
  t.jobs,
  t.imports,
  t.erpReceiptRecords,
  t.plans,
  t.planEntitlements,
  t.entitlementOverrides,
  t.commercialEvents,
  t.processingUsage,
  t.challenges,
  t.blogAuthors,
  t.blogCategories,
  t.blogTags,
  t.blogMedia,
  t.blogArticles,
  t.blogArticleTags,
  t.blogRevisions,
  t.blogRedirects,
  t.blogEvents,
];

describe('schema and migrations', () => {
  it('migrations from an empty database produce exactly the declared schema', async () => {
    const c = await connect(await database());
    const columns = await q<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      c,
      sql`select table_name, column_name, data_type, is_nullable from information_schema.columns
          where table_schema = 'public' order by table_name, ordinal_position`,
    );
    const inDb = new Map<string, Map<string, { type: string; nullable: boolean }>>();
    for (const r of columns) {
      const m = inDb.get(r.table_name) ?? new Map<string, { type: string; nullable: boolean }>();
      m.set(r.column_name, { type: r.data_type, nullable: r.is_nullable === 'YES' });
      inDb.set(r.table_name, m);
    }
    expect([...inDb.keys()].sort()).toEqual(TABLES.map((x) => getTableConfig(x).name).sort());
    for (const table of TABLES) {
      const cfg = getTableConfig(table);
      const db = inDb.get(cfg.name);
      expect([...(db?.keys() ?? [])].sort(), cfg.name).toEqual(
        Object.values(getTableColumns(table))
          .map((col) => col.name)
          .sort(),
      );
      for (const col of Object.values(getTableColumns(table)))
        expect(db?.get(col.name)?.nullable, `${cfg.name}.${col.name}`).toBe(
          !col.notNull && !col.primary,
        );
    }
  });

  it('money/quantity never float; instants are timestamptz(3); JSON is kept as text', async () => {
    const c = await connect(await database());
    const types = await q<{ data_type: string; n: number }>(
      c,
      sql`select data_type, count(*)::int as n from information_schema.columns
          where table_schema = 'public' group by data_type order by data_type`,
    );
    expect(types.map((x) => x.data_type).sort()).toEqual(
      ['bigint', 'boolean', 'bytea', 'integer', 'text', 'timestamp with time zone'].sort(),
    );
    // Raw bytes only for the blog's images, never for anything else.
    const bytes = await q<{ c: string }>(
      c,
      sql`select table_name || '.' || column_name as c from information_schema.columns
          where table_schema = 'public' and data_type = 'bytea' order by 1`,
    );
    expect(bytes.map((x) => x.c)).toEqual(['blog_media.body', 'blog_media.small_body']);
    const precision = await q<{ p: number }>(
      c,
      sql`select distinct datetime_precision::int as p from information_schema.columns
          where table_schema = 'public' and data_type = 'timestamp with time zone'`,
    );
    expect(precision).toEqual([{ p: 3 }]);
  });

  it('every declared foreign key, unique rule, check and index exists', async () => {
    const c = await connect(await database());
    const constraints = await q<{ name: string; type: string }>(
      c,
      sql`select conname as name, contype as type from pg_constraint
          where connamespace = 'public'::regnamespace`,
    );
    const indexes = (
      await q<{ name: string }>(
        c,
        sql`select indexname as name from pg_indexes where schemaname = 'public'`,
      )
    ).map((r) => r.name);
    for (const table of TABLES) {
      const cfg = getTableConfig(table);
      for (const fk of cfg.foreignKeys)
        expect(
          constraints.some((x) => x.name === fk.getName() && x.type === 'f'),
          fk.getName(),
        ).toBe(true);
      for (const ch of cfg.checks)
        expect(
          constraints.some((x) => x.name === ch.name && x.type === 'c'),
          ch.name,
        ).toBe(true);
      for (const ix of cfg.indexes) expect(indexes, ix.config.name).toContain(ix.config.name);
    }
    expect(constraints.filter((x) => x.type === 'f').length).toBeGreaterThanOrEqual(20);
  });

  it('constraints enforce the business invariants in the database itself', async () => {
    const h = await harness();
    const { invoiceId, documentId } = await h.veyra.upload(S('S01'));
    const reject = (p: Promise<unknown>) => expect(p).rejects.toThrow();
    // An unknown invoice state is refused.
    await reject(
      h.veyra.db.update(t.invoices).set({ state: 'PAID' }).where(eq(t.invoices.id, invoiceId)),
    );
    // A question marked answered without the answer is refused.
    await reject(
      h.veyra.db.insert(t.questions).values({
        id: '01K00000000000000000000Q01',
        invoiceId,
        kind: 'MISSING_DATA',
        code: 'MD_FIELD',
        subjectKey: 'x',
        prompt: 'p',
        contextJson: '{}',
        optionsJson: '[]',
        status: 'answered',
        assignedToUserId: DEMO_USER.id,
        createdAt: '2026-09-28T06:30:00.000Z',
      }),
    );
    // A foreign key to a missing invoice is refused.
    await reject(
      h.veyra.db.insert(t.jobs).values({
        id: '01K00000000000000000000J01',
        invoiceId: '01K0000000000000000000NONE',
        type: 'pipeline',
        status: 'queued',
        attempts: 0,
        runAfter: '2026-09-28T06:30:00.000Z',
        createdAt: '2026-09-28T06:30:00.000Z',
        updatedAt: '2026-09-28T06:30:00.000Z',
      }),
    );
    // The same document checksum twice is refused.
    const [doc] = await h.veyra.db.select().from(t.documents).where(eq(t.documents.id, documentId));
    await reject(
      h.veyra.db
        .insert(t.documents)
        .values({ ...must(doc), id: '01K00000000000000000000D02', seq: undefined as never }),
    );
    // A confirmed ERP write without the ERP record is refused.
    await reject(
      h.veyra.db.insert(t.erpWrites).values({
        idempotencyKey: 'veyra:x:y',
        invoiceId,
        operation: 'createVendor',
        status: 'confirmed',
        createdAt: '2026-09-28T06:30:00.000Z',
        updatedAt: '2026-09-28T06:30:00.000Z',
      }),
    );
  });
});

describe('timestamps and business dates', () => {
  it('instants round-trip as ISO-8601 UTC with milliseconds; business dates stay YYYY-MM-DD', async () => {
    const h = await harness();
    const id = await h.upload('S01');
    const inv = await h.veyra.invoiceRow(h.veyra.db, id);
    expect(inv.createdAt).toBe('2026-09-28T06:30:00.000Z');
    const stored = await h.veyra.db.execute(
      sql`select created_at::text as t, extract(timezone from created_at)::int as tz from invoices`,
    );
    expect(rowsOf<{ t: string; tz: number }>(stored)[0]).toEqual({
      t: '2026-09-28 06:30:00+00',
      tz: 0,
    });
    // The invoice date is a business date inside the validated JSON, never a timestamp.
    const [date] = await h.veyra.db
      .select({ v: t.extractedFields.valueJson })
      .from(t.extractedFields)
      .where(eq(t.extractedFields.path, 'header.invoiceDate'));
    expect(JSON.parse(must(date).v)).toBe('2026-09-15');
  });
});

describe('audit trail', () => {
  it('is listed in the order it was written, Veyrafy and You told apart', async () => {
    const h = await harness();
    const id = await h.upload('S03');
    await h.answer(id, 'CA_GRN', 'confirm', {
      grnDate: '2026-09-17',
      lines: [{ poLineNo: 1, received: '40', accepted: '40' }],
    });
    const rows = await h.veyra.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.invoiceId, id))
      .orderBy(asc(t.auditEvents.seq));
    const seqs = rows.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const shown = await new Presenter(h.veyra).audit(id);
    expect(shown.map((e) => `${e.by}: ${e.title}`).slice(0, 2)).toEqual([
      'You: Uploaded invoice',
      'Veyrafy: Read invoice',
    ]);
    expect(shown.some((e) => e.by === 'You' && e.title === 'Confirmed goods receipt')).toBe(true);
    expect(shown.at(-1)).toMatchObject({ by: 'Veyrafy', title: 'Ready for payment' });
  });

  it('is transactional: a failed operation leaves no audit row behind', async () => {
    const h = await harness();
    const id = await h.upload('S08');
    const before = (await h.veyra.db.select().from(t.auditEvents)).length;
    const question = must((await h.openQuestions(id))[0]);
    // Break the transition mid-transaction: the answer and its audit rows must all roll back.
    await h.veyra.db.update(t.invoices).set({ state: 'MATCHING' }).where(eq(t.invoices.id, id));
    await expect(
      h.veyra.answer(
        question.id,
        {
          optionId: 'confirm',
          input: {
            grnDate: '2026-09-20',
            lines: [{ poLineNo: 1, received: '50', accepted: '50' }],
          },
        },
        DEMO_USER.id,
      ),
    ).rejects.toThrow(VeyraError);
    expect((await h.veyra.db.select().from(t.auditEvents)).length).toBe(before);
    expect((await h.openQuestions(id)).map((x) => x.id)).toEqual([question.id]);
  });
});

describe('concurrency (several API and worker instances on one database)', () => {
  /** A second Veyra instance on the same database: another process, in effect. */
  async function peer(h: Harness): Promise<{ veyra: Veyra; runner: JobRunner }> {
    const c = await connect(h.database);
    const veyra = await new Veyra({
      db: c.db,
      erp: h.veyra.erp,
      extractor: h.veyra.extractor,
      storage: h.veyra.storage,
      clock: h.veyra.clock,
      initialSettings: DEMO_SETTINGS,
    }).init();
    return { veyra, runner: new JobRunner(veyra) };
  }

  it('two workers never claim the same job; each job is claimed exactly once', async () => {
    const h = await harness();
    const workers = [
      h.veyra,
      ...(await Promise.all([1, 2, 3].map(async () => (await peer(h)).veyra))),
    ];
    const ids: string[] = [];
    for (const s of ['S01', 'S02', 'S03', 'S04', 'S05', 'S07', 'S08', 'S09'])
      ids.push((await h.veyra.upload(S(s))).invoiceId);
    const claims = (
      await Promise.all(workers.flatMap((w) => Array.from({ length: 6 }, () => w.claimJob())))
    ).filter((x) => x !== null);
    expect(claims.map((c) => c.id).sort()).toEqual([...new Set(claims.map((c) => c.id))].sort());
    expect(claims).toHaveLength(ids.length);
    const running = await h.veyra.db.select().from(t.jobs).where(eq(t.jobs.status, 'running'));
    expect(running).toHaveLength(ids.length);
    expect(running.every((j) => j.attempts === 1)).toBe(true);
  });

  it('one invoice is never processed by two workers at once', async () => {
    const h = await harness();
    const { invoiceId } = await h.veyra.upload(S('S01'));
    const other = (await peer(h)).veyra;
    const first = await h.veyra.claimJob();
    expect(first?.invoiceId).toBe(invoiceId);
    // A second job for the same invoice is queued, but not claimable while the first runs.
    await h.veyra.db.transaction((tx) => h.veyra.enqueue(tx, invoiceId, 'pipeline'));
    expect(await other.claimJob()).toBeNull();
    await h.veyra.finishJob(must(first).id, { status: 'succeeded' });
    expect((await other.claimJob())?.invoiceId).toBe(invoiceId);
  });

  it('several workers draining together reach exactly the single-worker outcome: no duplicate ERP write', async () => {
    const scenarios = ['S01', 'S02', 'S12', 'S03'];
    // Reference: one worker, one invoice after another.
    const solo = await harness();
    const expected: string[] = [];
    for (const s of scenarios) expected.push(await solo.state(await solo.upload(s)));
    // Three workers on one database, all draining at once.
    const h = await harness();
    const peers = await Promise.all([1, 2].map(() => peer(h)));
    const ids: string[] = [];
    for (const s of scenarios) ids.push((await h.veyra.upload(S(s))).invoiceId);
    await Promise.all([h.runner.drain(), ...peers.map((p) => p.runner.drain())]);
    await h.runner.drain();
    expect(await Promise.all(ids.map((id) => h.state(id)))).toEqual(expected);
    expect(expected).toContain('VERIFIED_PENDING_PAYMENT');
    const pis = (await h.erp.listPurchaseInvoices()).filter((p) =>
      ids.includes(p.veyraInvoiceId ?? ''),
    );
    expect(pis).toHaveLength(expected.filter((x) => x === 'VERIFIED_PENDING_PAYMENT').length);
    expect(new Set(pis.map((p) => p.veyraInvoiceId)).size).toBe(pis.length);
    const jobs = await h.veyra.db.select().from(t.jobs);
    expect(jobs.every((j) => j.status === 'succeeded')).toBe(true);
  });

  it('the same answer submitted twice at once is recorded once; the other is refused', async () => {
    const h = await harness();
    const id = await h.upload('S08');
    const other = (await peer(h)).veyra;
    const question = must((await h.openQuestions(id))[0]);
    const body = {
      optionId: 'confirm',
      input: { grnDate: '2026-09-20', lines: [{ poLineNo: 1, received: '50', accepted: '50' }] },
    };
    const results = await Promise.allSettled([
      h.veyra.answer(question.id, body, DEMO_USER.id),
      other.answer(question.id, body, DEMO_USER.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(VeyraError);
    const answered = await h.veyra.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.event, 'question.answered'));
    expect(answered).toHaveLength(1);
  });

  it('answers get distinct, ordered sequence numbers under concurrency', async () => {
    const h = await harness();
    const ids = [await h.upload('S08'), await h.upload('S04')];
    const peers = await Promise.all([1, 2].map(async () => (await peer(h)).veyra));
    const open = await Promise.all(ids.map(async (id) => must((await h.openQuestions(id))[0])));
    await Promise.all([
      must(peers[0]).answer(
        must(open[0]).id,
        {
          optionId: 'confirm',
          input: {
            grnDate: '2026-09-20',
            lines: [{ poLineNo: 1, received: '50', accepted: '50' }],
          },
        },
        DEMO_USER.id,
      ),
      must(peers[1]).answer(must(open[1]).id, { optionId: 'approve', input: null }, DEMO_USER.id),
    ]);
    const seqs = (
      await h.veyra.db
        .select({ s: t.questions.answerSeq })
        .from(t.questions)
        .where(eq(t.questions.status, 'answered'))
    ).map((r) => r.s);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('the same file uploaded twice at once is stored once; the other upload is refused', async () => {
    const h = await harness();
    const other = (await peer(h)).veyra;
    const results = await Promise.allSettled([h.veyra.upload(S('S01')), other.upload(S('S01'))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await h.veyra.db.select().from(t.documents)).length).toBe(1);
    expect((await h.veyra.db.select().from(t.invoices)).length).toBe(1);
  });
});

describe('idempotent ERP writes under concurrency', () => {
  const key = creationIdempotencyKey(
    InvoiceIdSchema.parse('01K00000000000000000000001'),
    CreationActionIdSchema.parse('01K00000000000000000000A01'),
  );
  const vendor = {
    name: 'Nandi Stationers Pvt Ltd',
    gstin: '29AADCN9753P1ZH',
    address: 'Bengaluru',
    sourceInvoiceId: InvoiceIdSchema.parse('01K00000000000000000000001'),
  };

  it('same key, same payload, sent concurrently: exactly one record', async () => {
    const h = await harness();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.veyra.erp.createVendor(vendor, key)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect((await h.erp.listVendors()).filter((v) => v.gstin === vendor.gstin)).toHaveLength(1);
  });

  it('same key, different payload: IDEMPOTENCY_CONFLICT, nothing written', async () => {
    const h = await harness();
    const results = await Promise.allSettled([
      h.veyra.erp.createVendor(vendor, key),
      h.veyra.erp.createVendor({ ...vendor, name: 'Other Stationers Pvt Ltd' }, key),
    ]);
    const conflicts = results.filter(
      (r) =>
        r.status === 'rejected' &&
        isErpConnectorError(r.reason) &&
        r.reason.code === 'IDEMPOTENCY_CONFLICT',
    );
    expect(conflicts).toHaveLength(1);
    expect((await h.erp.listVendors()).filter((v) => v.gstin === vendor.gstin)).toHaveLength(1);
  });

  it('the ERP write log records one row per key, even when writes race', async () => {
    const h = await harness();
    const id = await h.upload('S01');
    const rows = await h.veyra.db
      .select()
      .from(t.erpWrites)
      .where(
        eq(t.erpWrites.idempotencyKey, purchaseInvoiceIdempotencyKey(InvoiceIdSchema.parse(id))),
      );
    expect(rows).toMatchObject([{ status: 'confirmed', operation: 'recordPurchaseInvoice' }]);
  });
});

describe('performance sanity (not a benchmark)', () => {
  it('concurrent reads, claims and idempotent writes finish promptly, without lock waits', async () => {
    const h = await harness();
    const ids: string[] = [];
    for (const s of ['S01', 'S02', 'S12']) ids.push(await h.upload(s));
    const present = new Presenter(h.veyra);
    const started = Date.now();
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => present.detail(must(ids[i % ids.length]))),
    );
    await Promise.all(Array.from({ length: 30 }, () => h.veyra.claimJob()));
    await Promise.all(
      Array.from({ length: 30 }, () =>
        h.veyra.erp.createVendor(
          {
            name: 'Nandi Stationers Pvt Ltd',
            gstin: '29AADCN9753P1ZH',
            address: 'Bengaluru',
            sourceInvoiceId: InvoiceIdSchema.parse(ids[0]),
          },
          creationIdempotencyKey(
            InvoiceIdSchema.parse(ids[0]),
            CreationActionIdSchema.parse('01K00000000000000000000A02'),
          ),
        ),
      ),
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    const waiting = await h.veyra.db.execute(
      sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
    );
    expect(rowsOf<{ n: number }>(waiting)).toEqual([{ n: 0 }]);
  });
});
