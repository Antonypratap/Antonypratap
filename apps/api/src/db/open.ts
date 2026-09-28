import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type VeyraDb = BetterSQLite3Database<typeof schema>;
export type VeyraTx = Parameters<Parameters<VeyraDb['transaction']>[0]>[0];

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export class PendingMigrationsError extends Error {
  constructor(readonly pending: string[]) {
    super(
      `veyra.db has ${pending.length} pending migration(s): ${pending.join(', ')}. Run "npm run db:migrate -w @veyra/api" first.`,
    );
    this.name = 'PendingMigrationsError';
  }
}

/** Migrations in the repository, oldest first. */
function knownMigrations(): { tag: string; when: number }[] {
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries;
}

/** Migrations not yet applied to this database (drizzle records each by its timestamp). */
export function pendingMigrations(sqlite: Database.Database): string[] {
  const table = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get();
  const applied = new Set<number>(
    table
      ? (
          sqlite.prepare('SELECT created_at FROM __drizzle_migrations').all() as {
            created_at: number;
          }[]
        ).map((r) => Number(r.created_at))
      : [],
  );
  return knownMigrations()
    .filter((m) => !applied.has(m.when))
    .map((m) => m.tag);
}

/**
 * Opens (creating if needed) veyra.db. With `migrate` (development, staging, `db:migrate`) pending
 * migrations are applied; each runs once, in order, and is recorded, so running again is a no-op.
 * Without it (production startup) a database with pending migrations is refused: migrations are
 * a deliberate deployment step, after a backup, never a side effect of starting a server.
 */
export function openVeyraDb(
  filename: string,
  options: { migrate?: boolean } = {},
): { sqlite: Database.Database; db: VeyraDb } {
  const sqlite = new Database(filename);
  sqlite.pragma('busy_timeout = 5000');
  if (filename !== ':memory:') sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  if (options.migrate === false) {
    const pending = pendingMigrations(sqlite);
    if (pending.length > 0) {
      sqlite.close();
      throw new PendingMigrationsError(pending);
    }
    sqlite.pragma('foreign_keys = ON');
    return { sqlite, db };
  }
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
