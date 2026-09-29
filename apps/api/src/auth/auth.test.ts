import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ROLE_PERMISSIONS, can } from '@veyra/shared';
import { openVeyraDb, type VeyraDatabase } from '../db/open';
import * as t from '../db/schema';
import { createTestDatabase, type TestDatabase } from '../test/database';
import { DEMO_USER, ORGANIZATION_ID } from '../workflow/veyra';
import { hashPassword, passwordProblem, verifyPassword } from './passwords';
import { SessionStore, hashToken, safeEqual } from './sessions';
import { Users } from './users';

/** Phase 6C: password hashing, sessions and accounts, below the HTTP layer. */
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function store(policy = { idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 }) {
  const database: TestDatabase = await createTestDatabase();
  cleanup.push(() => database.drop());
  const pg: VeyraDatabase = await openVeyraDb({ url: database.url, migrate: false });
  cleanup.push(() => pg.close());
  // The designated approver, as Veyra's bootstrap creates it (an ADMIN without a password).
  await pg.db.insert(t.users).values({
    ...DEMO_USER,
    active: true,
    organizationId: ORGANIZATION_ID,
    role: 'ADMIN',
    passwordHash: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  let now = new Date('2026-09-28T06:30:00.000Z');
  const clock = () => now;
  const sessions = new SessionStore(pg.db, policy, clock);
  const users = new Users(pg.db, sessions, ORGANIZATION_ID, clock);
  const ctx = { userId: null, requestId: null };
  return {
    db: pg.db,
    sessions,
    users,
    ctx,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('passwords (Argon2id)', () => {
  it('hashes with Argon2id at the documented parameters, salted, never reversible', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b); // a fresh salt each time
    expect(a).not.toContain('correct horse');
    expect(await verifyPassword(a, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(a, 'correct horse battery stapler')).toBe(false);
  });

  it('an account without a password never verifies (the dummy hash is checked instead)', async () => {
    expect(await verifyPassword(null, '')).toBe(false);
    expect(await verifyPassword(null, 'anything at all')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await verifyPassword(await hashPassword('p'.repeat(20)), 'x'.repeat(5000))).toBe(false);
  });

  it('length rules only (12–256), no composition rules', () => {
    expect(passwordProblem('short')).toMatch(/at least 12/);
    expect(passwordProblem('a'.repeat(257))).toMatch(/at most 256/);
    expect(passwordProblem('twelve chars')).toBeNull();
  });

  it('constant-time comparison helper', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('roles and permissions', () => {
  it('are small and explicit: ADMIN all, FINANCE no user or security administration, REVIEWER reads and answers', () => {
    expect(can('ADMIN', 'users.manage')).toBe(true);
    expect(can('FINANCE', 'users.manage')).toBe(false);
    expect(can('FINANCE', 'security.audit')).toBe(false);
    expect(can('FINANCE', 'invoices.reject')).toBe(true);
    expect(ROLE_PERMISSIONS.REVIEWER).toEqual([
      'invoices.view',
      'documents.view',
      'questions.answer',
      'audit.invoice',
    ]);
    expect(can('SUPERUSER', 'invoices.view')).toBe(false);
  });
});

describe('sessions', () => {
  it('stores only the token hash; the token is 256 random bits', async () => {
    const s = await store();
    const { token, csrfToken } = await s.sessions.create(DEMO_USER.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await s.db.select().from(t.sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('expires after the idle time, and after the absolute time even when active', async () => {
    const s = await store({ idleMs: 10 * 60_000, absoluteMs: 60 * 60_000 });
    const idle = await s.sessions.create(DEMO_USER.id);
    s.advance(10 * 60_000 + 1);
    expect(await s.sessions.resolve(idle.token)).toBeNull();

    const busy = await s.sessions.create(DEMO_USER.id);
    for (let i = 0; i < 6; i++) {
      s.advance(9 * 60_000);
      expect(await s.sessions.resolve(busy.token)).not.toBeNull();
    }
    s.advance(7 * 60_000); // 61 minutes after sign-in
    expect(await s.sessions.resolve(busy.token)).toBeNull();
  });

  it('rejects revoked, unknown and malformed tokens', async () => {
    const s = await store();
    const a = await s.sessions.create(DEMO_USER.id);
    await s.sessions.revoke(a.token);
    expect(await s.sessions.resolve(a.token)).toBeNull();
    for (const bad of ['', 'x', 'a'.repeat(43), `${a.token}x`, "' or 1=1 --", undefined])
      expect(await s.sessions.resolve(bad)).toBeNull();
  });

  it('several sessions per user are independent; disabling the user ends all of them', async () => {
    const s = await store();
    const admin = await s.users.create(
      {
        email: 'Admin@Toit.example',
        name: 'Admin',
        role: 'ADMIN',
        password: 'a long admin password',
      },
      s.ctx,
    );
    const user = await s.users.create(
      {
        email: 'fin@toit.example',
        name: 'Fin',
        role: 'FINANCE',
        password: 'a long finance password',
      },
      s.ctx,
    );
    expect(admin.email).toBe('admin@toit.example');
    const one = await s.sessions.create(user.id);
    const two = await s.sessions.create(user.id);
    await s.sessions.revoke(one.token);
    expect(await s.sessions.resolve(two.token)).not.toBeNull();
    await s.users.update(user.id, { active: false }, s.ctx);
    expect(await s.sessions.resolve(two.token)).toBeNull();
    expect(await s.users.authenticate('fin@toit.example', 'a long finance password')).toBeNull();
  });

  it('a password change ends every session of the user', async () => {
    const s = await store();
    const u = await s.users.create(
      { email: 'r@toit.example', name: 'R', role: 'REVIEWER', password: 'first password here' },
      s.ctx,
    );
    const a = await s.sessions.create(u.id);
    await s.users.setPassword(u.id, 'second password here', s.ctx, 'password.reset');
    expect(await s.sessions.resolve(a.token)).toBeNull();
    expect(await s.users.authenticate('r@toit.example', 'first password here')).toBeNull();
    expect(await s.users.authenticate('R@TOIT.example ', 'second password here')).not.toBeNull();
    const events = (await s.users.events()).map((e) => e.e.event);
    expect(events).toEqual(['password.reset', 'user.created']);
  });

  it('the last active administrator can be neither disabled nor demoted', async () => {
    const s = await store();
    // The designated approver is an ADMIN too; take it out of the picture first.
    await s.db.update(t.users).set({ role: 'REVIEWER' }).where(eq(t.users.id, DEMO_USER.id));
    const admin = await s.users.create(
      { email: 'only@toit.example', name: 'Only', role: 'ADMIN', password: 'only admin password' },
      s.ctx,
    );
    await expect(s.users.update(admin.id, { active: false }, s.ctx)).rejects.toThrow(
      /last active administrator/,
    );
    await expect(s.users.update(admin.id, { role: 'FINANCE' }, s.ctx)).rejects.toThrow(
      /last active administrator/,
    );
  });

  it('duplicate emails are refused whatever their case', async () => {
    const s = await store();
    const input = { name: 'A', role: 'FINANCE' as const, password: 'password password' };
    await s.users.create({ ...input, email: 'a@toit.example' }, s.ctx);
    await expect(s.users.create({ ...input, email: 'A@toit.example' }, s.ctx)).rejects.toThrow(
      /already exists/,
    );
  });
});
