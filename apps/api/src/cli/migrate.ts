/**
 * Applies pending PostgreSQL migrations to the Veyra database and exits
 * (`npm run db:migrate -w @veyra/api`). The deployment step before starting a new version in
 * staging and production (docs/DEPLOYMENT.md). Safe to run again: applied migrations are recorded
 * and skipped. Nothing is ever dropped or reset.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../config';
import { PendingMigrationsError, openVeyraDb, pendingMigrations } from '../db/open';

try {
  const config = loadConfig(process.env, {
    dataDir: fileURLToPath(new URL('../../../../data/veyra', import.meta.url)),
  });
  const target = {
    url: config.database.url,
    pgliteDir: join(config.dataDir, 'pgdata'),
    pool: { ...config.database.pool, max: 1 },
  };
  // Which migrations are pending (opening without migrating refuses and names them).
  let pending: string[] = [];
  await openVeyraDb({ ...target, migrate: false }).then(
    (db) => db.close(),
    (e: unknown) => {
      if (!(e instanceof PendingMigrationsError)) throw e;
      pending = e.pending;
    },
  );
  const database = await openVeyraDb({ ...target, migrate: true });
  const left = await pendingMigrations(database.db);
  await database.close();
  if (left.length) throw new Error(`still pending: ${left.join(', ')}`);
  console.log(
    pending.length
      ? `Veyra database: applied ${pending.length} migration(s): ${pending.join(', ')}`
      : 'Veyra database: already up to date',
  );
} catch (error) {
  // Never the URL or its credentials: the configuration names variables only.
  console.error(
    error instanceof ConfigError
      ? error.message
      : `Migration failed: ${error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, '[database]') : 'unknown error'}`,
  );
  process.exit(1);
}
