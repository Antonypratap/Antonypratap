import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

/**
 * The Veyra application database (ARCHITECTURE §19): PostgreSQL, always, through Drizzle.
 *
 * - `DATABASE_URL` (staging, production, tests): a node-postgres connection POOL, created once per
 *   process and closed on shutdown. Sessions run in UTC.
 * - No URL (development and the local demo only): PGlite, the PostgreSQL engine embedded in the
 *   process, persisted in a folder. Same SQL, same schema, same migrations; no server to install.
 *
 * Either way the application sees one `VeyraDb` (a PostgreSQL Drizzle database) and async access.
 */
export type VeyraDb = PgDatabase<PgQueryResultHKT, typeof schema>;
export type VeyraTx = PgTransaction<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface DatabaseOptions {
  /** postgres:// URL. Absent: embedded PGlite in `pgliteDir` (development only). */
  url?: string | null;
  pgliteDir?: string;
  /** Apply pending migrations (development, staging, `db:migrate`); off: refuse to run if any. */
  migrate?: boolean;
  pool?: { max?: number; connectTimeoutMs?: number; statementTimeoutMs?: number };
}

export interface VeyraDatabase {
  db: VeyraDb;
  kind: 'postgres' | 'pglite';
  /** Readiness: a round trip to the database. */
  ping(): Promise<void>;
  /** Closes the pool (or the embedded engine). Idempotent. */
  close(): Promise<void>;
  /** Connection pool counts (Phase 7): open, idle, and requests waiting for a connection. */
  poolStats(): { total: number; idle: number; waiting: number; max: number } | null;
}

export class PendingMigrationsError extends Error {
  constructor(readonly pending: string[]) {
    super(
      `The Veyra database has ${pending.length} pending migration(s): ${pending.join(', ')}. Run "npm run db:migrate -w @veyra/api" first.`,
    );
    this.name = 'PendingMigrationsError';
  }
}

/** Migrations in the repository, oldest first. */
export function knownMigrations(): { tag: string; when: number }[] {
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries;
}

/** Migrations not yet applied (Drizzle records each in drizzle.__drizzle_migrations). */
export async function pendingMigrations(db: VeyraDb): Promise<string[]> {
  const table = await db.execute<{ t: string | null }>(
    sql`select to_regclass('drizzle.__drizzle_migrations')::text as t`,
  );
  const applied = new Set<number>();
  if (rowsOf<{ t: string | null }>(table)[0]?.t) {
    const rows = await db.execute<{ created_at: string | number }>(
      sql`select created_at from drizzle.__drizzle_migrations`,
    );
    for (const r of rowsOf<{ created_at: string | number }>(rows))
      applied.add(Number(r.created_at));
  }
  return knownMigrations()
    .filter((m) => !applied.has(m.when))
    .map((m) => m.tag);
}

/** Rows of a raw `execute` result (node-postgres and PGlite shape them the same way). */
export function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export async function openVeyraDb(options: DatabaseOptions): Promise<VeyraDatabase> {
  let handle: VeyraDatabase;
  if (options.url) {
    const pool = new pg.Pool({
      connectionString: options.url,
      max: options.pool?.max ?? 10,
      connectionTimeoutMillis: options.pool?.connectTimeoutMs ?? 5_000,
      idleTimeoutMillis: 30_000,
      // Every session in UTC; a runaway statement is cancelled instead of holding a connection.
      options: `-c TimeZone=UTC -c statement_timeout=${options.pool?.statementTimeoutMs ?? 30_000}`,
      application_name: 'veyra-api',
    });
    // An idle client losing its connection must not crash the process; the pool replaces it.
    pool.on('error', () => undefined);
    const db = drizzleNodePg(pool, { schema }) as unknown as VeyraDb;
    let closed: Promise<void> | null = null;
    handle = {
      db,
      kind: 'postgres',
      ping: async () => {
        await db.execute(sql`select 1`);
      },
      close: () => (closed ??= pool.end()),
      poolStats: () => ({
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: options.pool?.max ?? 10,
      }),
    };
    try {
      if (options.migrate !== false)
        await migrateNodePg(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
    } catch (error) {
      await handle.close();
      throw error;
    }
  } else {
    if (!options.pgliteDir) throw new Error('an embedded database needs a folder');
    mkdirSync(options.pgliteDir, { recursive: true });
    const client = await PGlite.create(options.pgliteDir);
    await client.exec(`SET TIME ZONE 'UTC'`);
    const db = drizzlePglite({ client, schema }) as unknown as VeyraDb;
    let closed: Promise<void> | null = null;
    handle = {
      db,
      kind: 'pglite',
      ping: async () => {
        await db.execute(sql`select 1`);
      },
      close: () => (closed ??= client.closed ? Promise.resolve() : client.close()),
      poolStats: () => null,
    };
    if (options.migrate !== false)
      await migratePglite(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  }
  if (options.migrate === false) {
    const pending = await pendingMigrations(handle.db);
    if (pending.length > 0) {
      await handle.close();
      throw new PendingMigrationsError(pending);
    }
  }
  return handle;
}
