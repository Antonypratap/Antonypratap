/**
 * Moves an existing Veyra SQLite database (before Phase 6A) into the PostgreSQL application
 * database, once, and verifies it (docs/DEPLOYMENT.md "Moving an existing SQLite database").
 *
 *   npm run db:migrate-from-sqlite -w @veyra/api -- --from /var/lib/veyra/veyra.db [--dry-run]
 *
 * The target is DATABASE_URL (or, in development, the embedded database). It must be migrated
 * (`db:migrate`) and empty. The SQLite file is only read and is never deleted. Any verification
 * difference rolls everything back.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../config';
import { openVeyraDb } from '../db/open';
import { MigrationVerificationError, importFromSqlite } from '../db/sqlite-import';

const args = process.argv.slice(2);
const from = args[args.indexOf('--from') + 1];
const dryRun = args.includes('--dry-run');
if (!args.includes('--from') || !from) {
  console.error('Usage: db:migrate-from-sqlite -- --from <path to veyra.db> [--dry-run]');
  process.exit(2);
}

try {
  const config = loadConfig(process.env, {
    dataDir: fileURLToPath(new URL('../../../../data/veyra', import.meta.url)),
  });
  const target = await openVeyraDb({
    url: config.database.url,
    pgliteDir: join(config.dataDir, 'pgdata'),
    migrate: false,
    pool: { ...config.database.pool, max: 2 },
  });
  try {
    const report = await importFromSqlite({ sqliteFile: resolve(from), target: target, dryRun });
    console.log(`Source ${resolve(from)} (sha256 ${report.sourceSha256}), left unchanged.`);
    console.log('table                  sqlite  postgres');
    for (const r of report.tables)
      console.log(
        `${r.table.padEnd(22)} ${String(r.sqlite).padStart(6)}  ${String(r.postgres).padStart(8)}`,
      );
    for (const c of report.checks) console.log(`✓ ${c}`);
    console.log(
      report.committed
        ? 'Imported and verified. Keep the SQLite file as a backup until you have checked the app.'
        : 'Dry run: verified, then rolled back. Nothing was written.',
    );
  } finally {
    await target.close();
  }
} catch (error) {
  if (error instanceof ConfigError || error instanceof MigrationVerificationError)
    console.error(error.message);
  else
    console.error(
      `Import failed; nothing was kept: ${error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, '[database]') : 'unknown error'}`,
    );
  process.exit(1);
}
