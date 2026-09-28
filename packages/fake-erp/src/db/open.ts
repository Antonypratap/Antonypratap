import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type FakeErpDb = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Opens (creating if needed) a fake ERP database and applies pending migrations. */
export function openDatabase(
  filename: string,
  options: { busyTimeoutMs: number },
): { sqlite: Database.Database; db: FakeErpDb } {
  const sqlite = new Database(filename);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`busy_timeout = ${Math.trunc(options.busyTimeoutMs)}`);
  if (filename !== ':memory:') sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { sqlite, db };
}
