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
  sqlite.pragma(`busy_timeout = ${Math.trunc(options.busyTimeoutMs)}`);
  if (filename !== ':memory:') sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  // Migrations that rebuild a table (to change its CHECK constraints) must run with foreign keys
  // off; the pragma is ignored inside the migration's transaction, so it is set around it. The
  // result is then verified before foreign keys are enforced again (SQLite's documented procedure).
  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const violations = sqlite.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0)
    throw new Error(`fake ERP migration left ${violations.length} broken references`);
  sqlite.pragma('foreign_keys = ON');
  return { sqlite, db };
}
