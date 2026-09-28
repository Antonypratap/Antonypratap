/**
 * Applies pending database migrations and exits (`npm run db:migrate -w @veyra/api`). The
 * deployment step before starting a new version in staging and production (docs/OPERATIONS.md).
 * Safe to run again: applied migrations are recorded and skipped.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ConfigError, loadConfig } from '../config';
import { openVeyraDb, pendingMigrations } from '../db/open';

try {
  const config = loadConfig(process.env, {
    dataDir: fileURLToPath(new URL('../../../../data/veyra', import.meta.url)),
  });
  mkdirSync(config.dataDir, { recursive: true });
  const file = join(config.dataDir, 'veyra.db');
  const probe = new Database(file);
  const before = pendingMigrations(probe);
  probe.close();
  openVeyraDb(file, { migrate: true }).sqlite.close();
  // The ERP is behind its connector: the fake ERP migrates its own file when the API opens it.
  console.log(
    before.length
      ? `veyra.db: applied ${before.length} migration(s): ${before.join(', ')}`
      : 'veyra.db: already up to date',
  );
} catch (error) {
  console.error(
    error instanceof ConfigError ? error.message : `Migration failed: ${String(error)}`,
  );
  process.exit(1);
}
