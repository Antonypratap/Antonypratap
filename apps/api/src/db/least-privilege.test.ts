import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { renderScenario, scenarioById } from '@veyra/extractor';
import { createApp } from '../app';
import { createTestDatabase, testDatabaseUrl } from '../test/database';
import { DEMO_NOW } from '../test/harness';
import { DEMO_USER } from '../workflow/veyra';

/**
 * Phase 6C: the documented least-privilege runtime role (apps/api/sql/runtime-role.sql) is enough
 * to run the whole workflow, and it cannot change the schema, delete rows or rewrite the audit
 * trails.
 */
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function asAdmin(url: string, text: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(text);
  } finally {
    await c.end();
  }
}

describe('least-privilege runtime role', () => {
  it('runs the workflow; cannot create, drop, delete or rewrite audit', async () => {
    const database = await createTestDatabase();
    const role = `veyra_app_${randomBytes(4).toString('hex')}`;
    const password = `test-only-${randomBytes(6).toString('hex')}`;
    await asAdmin(testDatabaseUrl(), `create role ${role} login password '${password}'`);
    cleanup.push(() => asAdmin(testDatabaseUrl(), `drop role if exists ${role}`));
    cleanup.push(() => database.drop());
    const script = readFileSync(new URL('../../sql/runtime-role.sql', import.meta.url), 'utf8');
    await asAdmin(database.url, script.replaceAll('veyra_app', role));
    await asAdmin(
      database.url,
      `grant connect on database "${new URL(database.url).pathname.slice(1)}" to ${role}`,
    );

    const u = new URL(database.url);
    u.username = role;
    u.password = password;
    const dir = mkdtempSync(join(tmpdir(), 'veyra-lp-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const app = await createApp({
      dataDir: dir,
      demo: true,
      allowFixtureExtractor: true,
      nodeEnv: 'test',
      clock: () => DEMO_NOW,
      migrate: false,
      database: { url: u.toString() },
    });
    cleanup.push(() => app.close(0));

    const s = scenarioById('S01');
    if (!s) throw new Error('S01');
    const { invoiceId } = await app.veyra.upload({ filename: s.file, bytes: renderScenario(s) });
    await app.runner.drain();
    expect((await app.veyra.invoiceRow(app.veyra.db, invoiceId)).state).toBe(
      'VERIFIED_PENDING_PAYMENT',
    );
    const session = await app.sessions.create(DEMO_USER.id);
    expect(await app.sessions.resolve(session.token)).not.toBeNull();
    await app.users.record('logout', { userId: DEMO_USER.id, requestId: null });

    const db = app.veyra.db;
    for (const statement of [
      sql`delete from invoices`,
      sql`delete from audit_events`,
      sql`update audit_events set detail_json = '{}'`,
      sql`update security_events set event = 'logout'`,
      sql`truncate jobs`,
      sql`drop table documents`,
      sql`create table extra (id int)`,
      sql`alter table users add column note text`,
    ])
      await expect(db.execute(statement)).rejects.toThrow();
  });
});
