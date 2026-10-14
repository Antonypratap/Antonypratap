/**
 * Encrypts data stored before encryption at rest was switched on, and rotates keys
 * (`npm run security:encrypt-existing -w @veyra/api -- [--dry-run] [--rewrap]`; docs/SECURITY.md,
 * "Encryption at rest"). Run with the service's own environment (the same VEYRA_DATA_KEYS,
 * VEYRA_SECRETS_KEY and DATABASE_URL). Safe to stop and run again. Prints counts only.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../config';
import { openVeyraDb } from '../db/open';
import { SecretBox } from '../erp-api/secrets';
import { encryptExisting } from '../security/encrypt-existing';
import { createStorage } from '../storage';

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== '--dry-run' && a !== '--rewrap');
if (unknown.length) {
  console.error(`Unknown option(s): ${unknown.join(' ')}. Use --dry-run and/or --rewrap.`);
  process.exit(2);
}

try {
  const config = loadConfig(process.env, {
    dataDir: fileURLToPath(new URL('../../../../data/veyra', import.meta.url)),
  });
  const database = await openVeyraDb({
    url: config.database.url?.reveal() ?? null,
    pgliteDir: join(config.dataDir, 'pgdata'),
    pool: { ...config.database.pool, max: 1 },
    migrate: false,
  });
  try {
    const report = await encryptExisting({
      db: database.db,
      storage: createStorage(config.storage),
      storageFor: (dir) => createStorage(config.storage, dir),
      storageDir: config.storage.dir,
      challengesDir: join(config.dataDir, 'challenges'),
      secrets: config.erpApi.secretsKey
        ? SecretBox.fromBase64(config.erpApi.secretsKey, config.erpApi.previousSecretsKeys)
        : null,
      dryRun: args.has('--dry-run'),
      rewrap: args.has('--rewrap'),
    });
    console.log(JSON.stringify(report, null, 2));
    const problems =
      report.documents.mismatched +
      report.imports.mismatched +
      report.erpAttachments.mismatched +
      report.otherFiles.mismatched;
    if (problems > 0) {
      console.error(
        `${String(problems)} file(s) no longer match their recorded checksum and were left untouched. Investigate before setting VEYRA_ENCRYPT_REQUIRE=true.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await database.close();
  }
} catch (error) {
  // Never a URL, a key or content: configuration errors name variables only.
  console.error(
    error instanceof ConfigError
      ? error.message
      : `Encryption failed: ${error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, '[database]') : 'unknown error'}`,
  );
  process.exit(1);
}
