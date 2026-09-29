/**
 * User administration from the server (`npm run users -w @veyra/api -- <command>`), for creating
 * the first administrator and for incident response (docs/SECURITY.md). Everything else is done
 * by an ADMIN in the product.
 *
 *   list
 *   create --email <email> --name <name> --role ADMIN|FINANCE|REVIEWER   (password on stdin)
 *   set-password --email <email>                                          (password on stdin)
 *   disable --email <email> | enable --email <email>
 *   revoke-sessions --email <email> | revoke-sessions --all
 *
 * The password is read from standard input (first line), never from arguments or the environment,
 * so it does not end up in shell history or process listings. For example:
 *   read -rs P && printf '%s\n' "$P" | npm run users -w @veyra/api -- create --email … && unset P
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNull } from 'drizzle-orm';
import { ROLES, type Role } from '@veyra/shared';
import { ConfigError, loadConfig } from '../config';
import { openVeyraDb } from '../db/open';
import * as t from '../db/schema';
import { SessionStore } from '../auth/sessions';
import { Users } from '../auth/users';
import { ORGANIZATION_ID, VeyraError } from '../workflow/veyra';

const [command, ...args] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Password (input is not hidden; prefer a pipe): ');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return (Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '').trimEnd();
}

try {
  const config = loadConfig(process.env, {
    dataDir: fileURLToPath(new URL('../../../../data/veyra', import.meta.url)),
  });
  const database = await openVeyraDb({
    url: config.database.url?.reveal() ?? null,
    pgliteDir: join(config.dataDir, 'pgdata'),
    migrate: false,
    pool: { ...config.database.pool, max: 1 },
  });
  const sessions = new SessionStore(database.db, config.auth.session);
  const users = new Users(database.db, sessions, ORGANIZATION_ID);
  const ctx = { userId: null, requestId: null };
  const byEmail = async () => {
    const email = flag('email');
    if (!email) throw new VeyraError('INVALID_INPUT', 'Give --email.');
    const id = await users.idOf(email);
    if (!id) throw new VeyraError('NOT_FOUND', 'No user with that email address.');
    return id;
  };
  try {
    switch (command) {
      case 'list':
        for (const u of await users.list())
          console.log(
            `${u.email.padEnd(36)} ${u.role.padEnd(9)} ${u.active ? 'active  ' : 'disabled'} ${u.passwordHash ? 'password' : 'no password'}  ${u.name}`,
          );
        break;
      case 'create': {
        const role = flag('role') as Role | undefined;
        if (!role || !ROLES.includes(role))
          throw new VeyraError('INVALID_INPUT', `Give --role ${ROLES.join('|')}.`);
        const user = await users.create(
          {
            email: flag('email') ?? '',
            name: flag('name') ?? '',
            role,
            password: await readPassword(),
          },
          ctx,
        );
        console.log(`Created ${user.email} (${user.role}).`);
        break;
      }
      case 'set-password':
        await users.setPassword(await byEmail(), await readPassword(), ctx, 'password.reset');
        console.log('Password set; every session of this user has ended.');
        break;
      case 'disable':
      case 'enable':
        await users.update(await byEmail(), { active: command === 'enable' }, ctx);
        console.log(command === 'disable' ? 'Disabled; sessions ended.' : 'Enabled.');
        break;
      case 'revoke-sessions':
        if (args.includes('--all')) {
          const n = await database.db
            .update(t.sessions)
            .set({ revokedAt: new Date().toISOString() })
            .where(isNull(t.sessions.revokedAt))
            .returning({ h: t.sessions.tokenHash });
          console.log(`Ended ${n.length} session(s). Everyone must sign in again.`);
        } else console.log(`Ended ${await sessions.revokeAllForUser(await byEmail())} session(s).`);
        break;
      default:
        console.error(
          'Usage: users list | create --email E --name N --role R | set-password --email E | disable --email E | enable --email E | revoke-sessions (--email E | --all)',
        );
        process.exitCode = 2;
    }
  } finally {
    await database.close();
  }
} catch (error) {
  // Never the database URL, a password or a hash.
  console.error(
    error instanceof ConfigError || error instanceof VeyraError
      ? error.message
      : 'The command failed. Check the database configuration and try again.',
  );
  process.exit(1);
}
