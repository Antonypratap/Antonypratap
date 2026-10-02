import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { asc, getTableColumns, sql } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { rowsOf, type VeyraDatabase, type VeyraDb } from './open';
import * as t from './schema';

/**
 * One-time, controlled migration of a Veyra SQLite database (before Phase 6A) into the PostgreSQL
 * application database (ARCHITECTURE §19, docs/DEPLOYMENT.md "Moving an existing SQLite database").
 *
 * Non-destructive by construction:
 * - the SQLite file is never written: it is copied (SQLite online backup), and the copy is brought
 *   up to the last SQLite schema with the retired SQLite migrations;
 * - the target must be migrated and EMPTY; everything is copied in ONE PostgreSQL transaction and
 *   verified inside it (counts per table, every value of every row, relationships, states, order);
 *   any difference rolls the whole copy back and nothing is left behind;
 * - `dryRun` does all of it and rolls back anyway.
 *
 * Nothing is transformed: ids, text, JSON (byte for byte), integers are copied as they are. The
 * only representation changes are the column types themselves: 0/1 → boolean, ISO-8601 text →
 * timestamptz (read back as the same ISO string), and SQLite's rowid → `seq` (insertion order).
 * Columns that did not exist in SQLite (Phase 6C user columns) are filled exactly as migration
 * 0001 fills them for existing PostgreSQL rows (`legacyValue`).
 */

export const LEGACY_SQLITE_MIGRATIONS = fileURLToPath(
  new URL('../../drizzle-sqlite', import.meta.url),
);

/** Tables in foreign-key order (parents first). */
export const TABLE_ORDER: PgTable[] = [
  t.users,
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
];

export interface TableReport {
  table: string;
  sqlite: number;
  postgres: number;
}

export interface SqliteImportReport {
  sourceSha256: string;
  tables: TableReport[];
  checks: string[];
  committed: boolean;
}

export class MigrationVerificationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Verification failed; nothing was kept:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'MigrationVerificationError';
  }
}

type Row = Record<string, unknown>;

/** The deployment's one organization (the same id migration 0001 creates). */
const ORGANIZATION_ID = '00000000000000000000000001';

/**
 * Columns added after the last SQLite schema (Phase 6C), exactly as migration 0001 fills them for
 * existing rows: every earlier user is the designated approver, an ADMIN of the one organization,
 * without a password (it cannot sign in). The email is lower-cased like 0001 does.
 */
function legacyValue(table: string, column: string, row: Row): { value: unknown } | null {
  // Documents from before retention existed: available, and kept (no retention mode).
  if (table === 'documents' && column === 'status') return { value: 'AVAILABLE' };
  if (table === 'documents' && column === 'retention_mode') return { value: 'KEEP' };
  if (table !== 'users') return null;
  if (column === 'organization_id') return { value: ORGANIZATION_ID };
  if (column === 'role') return { value: 'ADMIN' };
  if (column === 'updated_at') return { value: row.created_at };
  if (column === 'password_hash' || column === 'password_changed_at') return { value: null };
  if (column === 'email' && typeof row.email === 'string')
    return { value: row.email.toLowerCase() };
  return null;
}

/** A source value for a target column: the SQLite value, or the documented fill for new columns. */
function sourceValue(table: string, column: string, row: Row, bools: Set<string>): unknown {
  const legacy = legacyValue(table, column, row);
  if (legacy && (column === 'email' || !(column in row)))
    return toPostgres(column, legacy.value, bools);
  return toPostgres(column, row[column], bools);
}

const TIMESTAMP_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'uploaded_at',
  'answered_at',
  'committed_at',
  'confirmed_at',
  'locked_at',
  'run_after',
]);

/** A SQLite value as the PostgreSQL column holds it (no semantic change; see the file header). */
function toPostgres(column: string, value: unknown, boolColumns: Set<string>): unknown {
  if (value === null || value === undefined) return null;
  if (boolColumns.has(column)) {
    if (value === 0 || value === 1) return value === 1;
    throw new Error(`${column}: not a 0/1 boolean`);
  }
  if (TIMESTAMP_COLUMNS.has(column)) {
    // Veyra always wrote Date#toISOString(); anything else is refused rather than reinterpreted.
    const s = String(value);
    const d = new Date(s);
    if (Number.isNaN(d.getTime()) || d.toISOString() !== s)
      throw new Error(`${column}: "${s}" is not a Veyrafy UTC timestamp; nothing was imported`);
    return s;
  }
  return value;
}

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The SQLite copy, brought to the last SQLite schema. The source file is only read. */
async function preparedCopy(
  sqliteFile: string,
): Promise<{ db: Database.Database; done: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-sqlite-import-'));
  const copy = join(dir, 'veyra-copy.db');
  const source = new Database(sqliteFile, { readonly: true, fileMustExist: true });
  try {
    await source.backup(copy);
  } finally {
    source.close();
  }
  const db = new Database(copy);
  db.pragma('foreign_keys = OFF');
  migrateSqlite(drizzleSqlite(db), { migrationsFolder: LEGACY_SQLITE_MIGRATIONS });
  return {
    db,
    done: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function importFromSqlite(options: {
  sqliteFile: string;
  target: VeyraDatabase;
  dryRun?: boolean;
}): Promise<SqliteImportReport> {
  const sourceSha256 = sha256File(options.sqliteFile);
  const copy = await preparedCopy(options.sqliteFile);
  const target = options.target.db;
  try {
    // The target must be the migrated schema, with nothing in it.
    const nonEmpty: string[] = [];
    for (const table of TABLE_ORDER) {
      const name = getTableConfig(table).name;
      const n = rowsOf<{ n: number }>(
        await target.execute(sql.raw(`select count(*)::int as n from "${name}"`)),
      )[0]?.n;
      if (n) nonEmpty.push(`${name} (${n})`);
    }
    if (nonEmpty.length)
      throw new Error(
        `The PostgreSQL database is not empty (${nonEmpty.join(', ')}). The import only fills an empty, migrated database.`,
      );

    let report: SqliteImportReport | null = null;
    const ROLLBACK = new Error('rollback (dry run)');
    try {
      await target.transaction(async (tx) => {
        const tables: TableReport[] = [];
        for (const table of TABLE_ORDER) {
          const cfg = getTableConfig(table);
          const columns = getTableColumns(table);
          const bools = new Set(
            Object.values(columns)
              .filter((c) => c.columnType === 'PgBoolean')
              .map((c) => c.name),
          );
          const hasSeq = 'seq' in columns;
          const rows = copy.db
            .prepare(`select rowid as "__rowid", * from "${cfg.name}" order by rowid`)
            .all() as Row[];
          for (let i = 0; i < rows.length; i += 200) {
            const batch = rows.slice(i, i + 200).map((r) => {
              const out: Row = {};
              for (const [key, col] of Object.entries(columns)) {
                if (key === 'seq') continue;
                out[key] = sourceValue(cfg.name, col.name, r, bools);
              }
              if (hasSeq) out.seq = Number(r.__rowid);
              return out;
            });
            if (batch.length) await tx.insert(table).values(batch as never);
          }
          if (hasSeq)
            await tx.execute(
              sql.raw(
                `select setval(pg_get_serial_sequence('"${cfg.name}"', 'seq'), coalesce((select max(seq) from "${cfg.name}"), 0) + 1, false)`,
              ),
            );
          tables.push({ table: cfg.name, sqlite: rows.length, postgres: 0 });
        }
        const checks = await verify(copy.db, tx as unknown as VeyraDb, tables);
        report = { sourceSha256, tables, checks, committed: !options.dryRun };
        if (options.dryRun) throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    }
    if (sha256File(options.sqliteFile) !== sourceSha256)
      throw new Error('The SQLite file changed during the import; import it again.');
    if (!report) throw new Error('import produced no report');
    return report;
  } finally {
    copy.done();
  }
}

/**
 * Verification (inside the copy's transaction): for every table the row counts match, every row
 * of SQLite is in PostgreSQL with the same value in every column, insertion order is kept, and
 * the key relationships and workflow states agree. Throws MigrationVerificationError otherwise.
 */
export async function verify(
  source: Database.Database,
  target: VeyraDb,
  tables: TableReport[],
): Promise<string[]> {
  const problems: string[] = [];
  const checks: string[] = [];
  for (const table of TABLE_ORDER) {
    const cfg = getTableConfig(table);
    const columns = getTableColumns(table);
    const bools = new Set(
      Object.values(columns)
        .filter((c) => c.columnType === 'PgBoolean')
        .map((c) => c.name),
    );
    const pk =
      cfg.name === 'settings' ? 'key' : cfg.name === 'erp_writes' ? 'idempotency_key' : 'id';
    const src = source
      .prepare(`select rowid as "__rowid", * from "${cfg.name}" order by rowid`)
      .all() as Row[];
    const orderBy = 'seq' in columns ? asc((columns as { seq: never }).seq) : undefined;
    const dst = (await (orderBy
      ? target.select().from(table).orderBy(orderBy)
      : target.select().from(table))) as Row[];
    const report = tables.find((x) => x.table === cfg.name);
    if (report) report.postgres = dst.length;
    if (src.length !== dst.length) {
      problems.push(`${cfg.name}: ${src.length} rows in SQLite, ${dst.length} in PostgreSQL`);
      continue;
    }
    const byKey = new Map(dst.map((r) => [String(r[keyOf(columns, pk)]), r]));
    for (const s of src) {
      const d = byKey.get(String(s[pk]));
      if (!d) {
        problems.push(`${cfg.name}: row ${String(s[pk])} missing`);
        continue;
      }
      for (const [key, col] of Object.entries(columns)) {
        const expected =
          key === 'seq' ? Number(s.__rowid) : sourceValue(cfg.name, col.name, s, bools);
        if (!Object.is(expected, d[key]) && JSON.stringify(expected) !== JSON.stringify(d[key]))
          problems.push(`${cfg.name}.${col.name} differs for ${String(s[pk])}`);
      }
    }
    if (
      'seq' in columns &&
      dst.map((r) => r[keyOf(columns, pk)]).join() !== src.map((r) => r[pk]).join()
    )
      problems.push(`${cfg.name}: insertion order differs`);
    checks.push(`${cfg.name}: ${src.length} rows, every value equal`);
  }
  // Relationships and workflow states, counted on both sides.
  const same = async (label: string, sqliteSql: string, pgSql: string) => {
    const a = JSON.stringify(source.prepare(sqliteSql).all());
    const b = JSON.stringify(rowsOf(await target.execute(sql.raw(pgSql))));
    if (a !== b) problems.push(`${label}: ${a} ≠ ${b}`);
    else checks.push(`${label}: equal`);
  };
  await same(
    'invoices by state',
    'select state, count(*) as n from invoices group by state order by state',
    'select state, count(*)::int as n from invoices group by state order by state collate "C"',
  );
  await same(
    'questions by status',
    'select status, count(*) as n from questions group by status order by status',
    'select status, count(*)::int as n from questions group by status order by status collate "C"',
  );
  await same(
    'ERP writes by status',
    'select status, count(*) as n from erp_writes group by status order by status',
    'select status, count(*)::int as n from erp_writes group by status order by status collate "C"',
  );
  await same(
    'audit events per invoice',
    "select coalesce(invoice_id, '-') as invoice, count(*) as n from audit_events group by invoice_id order by invoice",
    "select coalesce(invoice_id, '-') as invoice, count(*)::int as n from audit_events group by invoice_id order by coalesce(invoice_id, '-') collate \"C\"",
  );
  await same(
    'invoices with their document',
    'select count(*) as n from invoices i join documents d on d.id = i.document_id',
    'select count(*)::int as n from invoices i join documents d on d.id = i.document_id',
  );
  await same(
    'answers in order',
    'select id, answer_seq from questions where answer_seq is not null order by answer_seq',
    'select id, answer_seq from questions where answer_seq is not null order by answer_seq',
  );
  await same(
    'jobs by status',
    'select status, count(*) as n from jobs group by status order by status',
    'select status, count(*)::int as n from jobs group by status order by status collate "C"',
  );
  if (problems.length) throw new MigrationVerificationError(problems);
  return checks;
}

function keyOf(columns: Record<string, { name: string }>, column: string): string {
  const entry = Object.entries(columns).find(([, c]) => c.name === column);
  if (!entry) throw new Error(`no column ${column}`);
  return entry[0];
}
