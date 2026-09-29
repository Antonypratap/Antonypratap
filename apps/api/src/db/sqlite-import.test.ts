import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { renderScenario, scenarioById } from '@veyra/extractor';
import { openVeyraDb, rowsOf, type VeyraDatabase, type VeyraDb } from './open';
import * as t from './schema';
import {
  LEGACY_SQLITE_MIGRATIONS,
  MigrationVerificationError,
  TABLE_ORDER,
  importFromSqlite,
  verify,
} from './sqlite-import';
import { createTestDatabase, type TestDatabase } from '../test/database';
import { createHarness, type Harness } from '../test/harness';
import { Presenter } from '../http/present';
import { DEMO_SETTINGS, DEMO_USER, Veyra } from '../workflow/veyra';

/**
 * Phase 6A data migration: a representative Veyra SQLite database (every table, every workflow
 * state) is moved into PostgreSQL and verified; nothing is transformed and the source is untouched.
 */
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** Builds real workflow data (on PostgreSQL), covering every table and state. */
async function representative(): Promise<Harness> {
  const h = await createHarness();
  cleanup.push(() => h.close());
  await h.upload('S01'); // verified, with ERP writes
  const s03 = await h.upload('S03'); // new vendor + PO, GRN approved by the user, verified
  await h.answer(s03, 'CA_GRN', 'confirm', {
    grnDate: '2026-09-17',
    lines: [{ poLineNo: 1, received: '40', accepted: '40' }],
  });
  await h.upload('S08'); // waiting for the user (open question)
  const s09 = await h.upload('S09'); // one paisa: rejected by the user
  await h.veyra.reject(s09, 'Totals do not agree', DEMO_USER.id);
  const { invoiceId: broken } = await h.veyra.upload({
    filename: 'scan.pdf',
    bytes: new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Garbage >>\ntrailer\n%%EOF\n'),
  });
  await h.runner.drain(); // failed at extraction
  expect(await h.state(broken)).toBe('FAILED');
  // A queued job left behind, and a document stored before Phase 6 (absolute legacy path).
  const s = scenarioById('S02');
  if (!s) throw new Error('S02');
  const { documentId } = await h.veyra.upload({ filename: s.file, bytes: renderScenario(s) });
  await h.veyra.db
    .update(t.documents)
    .set({ storagePath: `/var/lib/veyra/uploads/${documentId}.pdf` })
    .where(eq(t.documents.id, documentId));
  // A business-record import event without an invoice.
  await h.veyra.db.transaction((tx) =>
    h.veyra.audit(tx, null, { type: 'user', userId: DEMO_USER.id }, 'records.import_checked', {
      importId: '01K00000000000000000000I01',
      files: ['Vendors.xlsx'],
      tables: [],
      errorCount: 0,
    }),
  );
  await h.veyra.db.insert(t.imports).values({
    id: '01K00000000000000000000I01',
    filesJson: JSON.stringify([
      {
        filename: 'Vendors.xlsx',
        path: '/var/lib/veyra/uploads/imports/x/1-Vendors.xlsx',
        sha256: 'ab',
        sizeBytes: 10,
      },
    ]),
    kinds: 'Vendors',
    status: 'ready',
    checkJson: '{"tables":[],"errors":[]}',
    resultJson: null,
    uploadedByUserId: DEMO_USER.id,
    confirmedByUserId: null,
    createdAt: '2026-09-28T06:30:00.000Z',
    confirmedAt: null,
  });
  return h;
}

/** Writes a Veyra PostgreSQL database out as a pre-6A SQLite file (the retired SQLite schema). */
async function asLegacySqlite(db: VeyraDb): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-legacy-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'veyra.db');
  const sqlite = new Database(file);
  migrateSqlite(drizzleSqlite(sqlite), { migrationsFolder: LEGACY_SQLITE_MIGRATIONS });
  sqlite.pragma('foreign_keys = ON');
  for (const table of TABLE_ORDER) {
    const cfg = getTableConfig(table);
    // Only the columns the SQLite schema had (Phase 6C user columns did not exist there).
    const legacy = new Set(
      (sqlite.prepare(`pragma table_info("${cfg.name}")`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    const columns = Object.entries(getTableColumns(table)).filter(
      ([k, c]) => k !== 'seq' && legacy.has(c.name),
    );
    const rows = (await ('seq' in getTableColumns(table)
      ? db
          .select()
          .from(table)
          .orderBy(asc((getTableColumns(table) as { seq: never }).seq))
      : db.select().from(table))) as Record<string, unknown>[];
    const insert = sqlite.prepare(
      `insert into "${cfg.name}" (${columns.map(([, c]) => `"${c.name}"`).join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    );
    for (const r of rows)
      insert.run(...columns.map(([k]) => (typeof r[k] === 'boolean' ? (r[k] ? 1 : 0) : r[k])));
  }
  sqlite.close();
  return file;
}

async function emptyTarget(): Promise<{ db: VeyraDatabase; database: TestDatabase }> {
  const database = await createTestDatabase();
  cleanup.push(() => database.drop());
  const db = await openVeyraDb({ url: database.url, migrate: false, pool: { max: 2 } });
  cleanup.push(() => db.close());
  return { db, database };
}

/** Every row of every table, without the seq values themselves (order is compared separately). */
async function contents(db: VeyraDb) {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLE_ORDER) {
    const hasSeq = 'seq' in getTableColumns(table);
    const rows = (await (hasSeq
      ? db
          .select()
          .from(table)
          .orderBy(asc((getTableColumns(table) as { seq: never }).seq))
      : db.select().from(table))) as Record<string, unknown>[];
    out[getTableConfig(table).name] = rows.map((r) => {
      const copy = { ...r };
      delete copy.seq;
      return copy;
    });
  }
  return out;
}

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

describe('SQLite → PostgreSQL data migration', () => {
  it('moves a representative database: every table, id, timestamp, state, question, answer, audit event and ERP write', async () => {
    const h = await representative();
    const file = await asLegacySqlite(h.veyra.db);
    const before = sha(file);
    const { db } = await emptyTarget();

    const report = await importFromSqlite({ sqliteFile: file, target: db });

    expect(report.committed).toBe(true);
    expect(sha(file)).toBe(before); // the source is never written
    for (const r of report.tables) expect(r.postgres, r.table).toBe(r.sqlite);
    expect(report.tables.find((r) => r.table === 'audit_events')?.sqlite).toBeGreaterThan(40);
    for (const name of [
      'invoices',
      'questions',
      'erp_writes',
      'jobs',
      'imports',
      'creation_actions',
    ])
      expect(report.tables.find((r) => r.table === name)?.sqlite, name).toBeGreaterThan(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        'invoices by state: equal',
        'questions by status: equal',
        'ERP writes by status: equal',
        'audit events per invoice: equal',
        'answers in order: equal',
      ]),
    );
    // Byte-for-byte the same data as the original, in the same order.
    expect(await contents(db.db)).toEqual(await contents(h.veyra.db));
    const states = rowsOf<{ state: string }>(
      await db.db.execute(sql`select distinct state from invoices order by state`),
    ).map((r) => r.state);
    expect(states).toEqual([
      'FAILED',
      'NEEDS_INPUT',
      'REJECTED',
      'UPLOADED',
      'VERIFIED_PENDING_PAYMENT',
    ]);
    // New rows continue after the imported ones.
    const next = rowsOf<{ n: string }>(
      await db.db.execute(
        sql`select nextval(pg_get_serial_sequence('audit_events', 'seq'))::text as n`,
      ),
    )[0]?.n;
    expect(Number(next)).toBe(
      (report.tables.find((r) => r.table === 'audit_events')?.sqlite ?? 0) + 1,
    );
  });

  it('the product shows exactly the same inbox, invoices, questions and audit trail afterwards', async () => {
    const h = await representative();
    const file = await asLegacySqlite(h.veyra.db);
    const { db } = await emptyTarget();
    await importFromSqlite({ sqliteFile: file, target: db });
    const moved = await new Veyra({
      db: db.db,
      erp: h.veyra.erp,
      extractor: h.veyra.extractor,
      storage: h.veyra.storage,
      clock: h.veyra.clock,
      initialSettings: DEMO_SETTINGS,
    }).init();
    const [a, b] = [new Presenter(h.veyra), new Presenter(moved)];
    expect(await b.inbox()).toEqual(await a.inbox());
    expect(await b.audit(null)).toEqual(await a.audit(null));
    expect(await b.questions('open')).toEqual(await a.questions('open'));
    expect(await b.questions('answered')).toEqual(await a.questions('answered'));
    for (const inv of (await a.inbox()).invoices)
      expect(await b.detail(inv.id)).toEqual(await a.detail(inv.id));
  });

  it('a dry run verifies everything and keeps nothing', async () => {
    const h = await representative();
    const file = await asLegacySqlite(h.veyra.db);
    const { db } = await emptyTarget();
    const report = await importFromSqlite({ sqliteFile: file, target: db, dryRun: true });
    expect(report.committed).toBe(false);
    expect(report.tables.every((r) => r.postgres === r.sqlite)).toBe(true);
    for (const table of TABLE_ORDER)
      expect(await db.db.select().from(table), getTableConfig(table).name).toEqual([]);
  });

  it('refuses a target that is not empty', async () => {
    const h = await representative();
    const file = await asLegacySqlite(h.veyra.db);
    await expect(
      importFromSqlite({ sqliteFile: file, target: { ...h.veyra, db: h.veyra.db } as never }),
    ).rejects.toThrow(/not empty/);
  });

  it('refuses data it would have to reinterpret, and keeps nothing', async () => {
    const h = await representative();
    const file = await asLegacySqlite(h.veyra.db);
    const legacy = new Database(file);
    legacy.prepare("update jobs set created_at = '28/09/2026 12:00'").run();
    legacy.close();
    const { db } = await emptyTarget();
    await expect(importFromSqlite({ sqliteFile: file, target: db })).rejects.toThrow(
      /not a Veyra UTC timestamp/,
    );
    expect(await db.db.select().from(t.invoices)).toEqual([]);
  });

  it('verification names any difference (and fails the import)', async () => {
    const h = await representative();
    const file = await asLegacySqlite(h.veyra.db);
    const { db } = await emptyTarget();
    await importFromSqlite({ sqliteFile: file, target: db });
    const source = new Database(file, { readonly: true });
    cleanup.push(() => {
      source.close();
    });
    await expect(verify(source, db.db, [])).resolves.toBeDefined();
    await db.db
      .update(t.invoices)
      .set({ failureReason: 'changed' })
      .where(eq(t.invoices.state, 'FAILED'));
    const error = await verify(source, db.db, []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationVerificationError);
    expect((error as MigrationVerificationError).problems).toEqual([
      expect.stringMatching(/^invoices\.failure_reason differs for /),
    ]);
  });
});
