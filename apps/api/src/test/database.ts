import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { MIGRATIONS_FOLDER, openVeyraDb } from '../db/open';

/**
 * TEST DATABASE STRATEGY (ARCHITECTURE §19, docs/DEPLOYMENT.md).
 *
 * Tests run against a real PostgreSQL server named by TEST_DATABASE_URL (a disposable server:
 * CI's service container, a local Docker container, or a throwaway local cluster). The URL's
 * role must be allowed to create databases. Nothing falls back to SQLite or to an embedded engine.
 *
 * Each test gets its own database, cloned from a template that holds the migrated schema (the
 * template is built once per migration set), and dropped afterwards.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      'TEST_DATABASE_URL is not set. The API tests run against PostgreSQL: point it at a disposable ' +
        'server whose user may create databases, e.g. postgres://veyra_test:veyra_test@127.0.0.1:5432/veyra_test ' +
        '(see docs/DEPLOYMENT.md, "Test database").',
    );
  return url;
}

const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

/** A short hash of the migration files: the template is rebuilt when they change. */
function migrationsHash(): string {
  const h = createHash('sha256');
  for (const f of readdirSync(MIGRATIONS_FOLDER).sort())
    if (f.endsWith('.sql')) h.update(readFileSync(`${MIGRATIONS_FOLDER}/${f}`));
  h.update(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`));
  return h.digest('hex').slice(0, 12);
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let template: Promise<string> | null = null;

/** The migrated template database, created once (safely across parallel test workers). */
function templateName(): Promise<string> {
  template ??= (async () => {
    const name = `veyra_tpl_${migrationsHash()}`;
    await admin(async (c) => {
      await c.query('select pg_advisory_lock(7665100)');
      try {
        const exists = await c.query('select 1 from pg_database where datname = $1', [name]);
        if (exists.rowCount) return;
        await c.query(`create database "${name}_building"`);
        const built = await openVeyraDb({
          url: withDatabase(testDatabaseUrl(), `${name}_building`),
          migrate: true,
          pool: { max: 1 },
        });
        await built.close();
        await c.query(`alter database "${name}_building" rename to "${name}"`);
      } finally {
        await c.query('select pg_advisory_unlock(7665100)');
      }
    });
    return name;
  })();
  return template;
}

export interface TestDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

/** A fresh, migrated, empty database for one test (`bare`: no schema at all, not even migrations). */
export async function createTestDatabase(options: { bare?: boolean } = {}): Promise<TestDatabase> {
  const tpl = options.bare ? 'template0' : await templateName();
  const name = `veyra_t_${randomBytes(6).toString('hex')}`;
  // CREATE DATABASE … TEMPLATE needs the template to have no other session; retry briefly.
  await admin(async (c) => {
    for (let i = 0; ; i++) {
      try {
        await c.query(`create database "${name}" template "${tpl}"`);
        return;
      } catch (error) {
        if (i >= 20 || !/being accessed by other users/.test(String(error))) throw error;
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      }
    }
  });
  let dropped = false;
  return {
    url: withDatabase(testDatabaseUrl(), name),
    name,
    drop: async () => {
      if (dropped) return;
      dropped = true;
      await admin((c) => c.query(`drop database if exists "${name}" with (force)`));
    },
  };
}
