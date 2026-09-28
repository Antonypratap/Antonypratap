import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type VeyraDb = BetterSQLite3Database<typeof schema>;
export type VeyraTx = Parameters<Parameters<VeyraDb['transaction']>[0]>[0];

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Opens (creating if needed) veyra.db and applies pending migrations. */
export function openVeyraDb(filename: string): { sqlite: Database.Database; db: VeyraDb } {
  const sqlite = new Database(filename);
  sqlite.pragma('busy_timeout = 5000');
  if (filename !== ':memory:') sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  // Table-rebuilding migrations need foreign keys off (ignored inside the migration's own
  // transaction); references are verified before they are enforced again.
  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const violations = sqlite.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0)
    throw new Error(`veyra.db migration left ${violations.length} broken references`);
  sqlite.pragma('foreign_keys = ON');
  return { sqlite, db };
}
