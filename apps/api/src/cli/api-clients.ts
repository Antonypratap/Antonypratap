/**
 * API keys for the Client Invoice Verification API (docs/VERIFY-API.md), managed from the server
 * (`npm run api-clients -w @veyra/api -- <command>`):
 *
 *   create --name <client name>   prints the new key ONCE (store it in the client's secret store)
 *   list                          clients, key prefixes and status (never a key)
 *   revoke --id <client id>       the key stops working at once
 *
 * Keys are stored only as hashes: a lost key cannot be shown again; revoke it and create another.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, cliDatabase } from '../config';
import { openVeyraDb } from '../db/open';
import { ApiClients } from '../verify/clients';

const [command, ...args] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

try {
  const config = cliDatabase(process.env, {
    dataDir: fileURLToPath(new URL('../../../../data/veyra', import.meta.url)),
  });
  const database = await openVeyraDb({
    url: config.database.url?.reveal() ?? null,
    pgliteDir: join(config.dataDir, 'pgdata'),
    migrate: false,
    pool: { ...config.database.pool, max: 1 },
  });
  const clients = new ApiClients(database.db, () => new Date().toISOString());
  try {
    switch (command) {
      case 'create': {
        const name = flag('name');
        if (!name) throw new Error('Give --name.');
        const c = await clients.create(name);
        console.log(`API client ${c.id} (${c.name}) created.`);
        console.log("Its key, shown only now (store it in the client's secret store):");
        console.log(c.key);
        break;
      }
      case 'list':
        for (const c of await clients.list())
          console.log(
            `${c.id}  vfy_${c.keyPrefix}_…  ${c.status.padEnd(7)}  last used ${c.lastUsedAt ?? 'never'}  ${c.name}`,
          );
        break;
      case 'revoke': {
        const id = flag('id');
        if (!id) throw new Error('Give --id.');
        console.log((await clients.revoke(id)) ? 'Revoked.' : 'No such client.');
        break;
      }
      default:
        console.error('Usage: api-clients create --name <name> | list | revoke --id <id>');
        process.exitCode = 2;
    }
  } finally {
    await database.close();
  }
} catch (error) {
  console.error(
    error instanceof ConfigError
      ? error.message
      : `api-clients failed: ${error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, '[database]') : 'unknown error'}`,
  );
  process.exit(1);
}
