import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { ROLES, type Role, type SecurityEvent } from '@veyra/shared';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';
import { ulid } from '../ids';
import { VeyraError } from '../workflow/veyra';
import { hashPassword, passwordProblem, verifyPassword } from './passwords';
import type { SessionStore } from './sessions';

type UserRow = typeof t.users.$inferSelect;

/** Who is acting and on which request: recorded with every security event. */
export interface SecurityContext {
  userId: string | null;
  requestId: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * User accounts and the security audit trail (Phase 6C). Every account belongs to the deployment's
 * one organization. Nothing here returns or records a password or its hash.
 */
export class Users {
  constructor(
    readonly db: VeyraDb,
    readonly sessions: SessionStore,
    readonly organizationId: string,
    readonly clock: () => Date = () => new Date(),
  ) {}

  private now = () => this.clock().toISOString();

  /** Appends one security event. Detail holds ids and codes only (never secrets or contents). */
  async record(
    event: SecurityEvent,
    ctx: SecurityContext,
    detail: Record<string, string | number | boolean | null> = {},
    subjectUserId: string | null = null,
  ): Promise<void> {
    await this.db.insert(t.securityEvents).values({
      id: ulid(),
      event,
      userId: ctx.userId,
      subjectUserId,
      requestId: ctx.requestId,
      detailJson: JSON.stringify(detail),
      createdAt: this.now(),
    });
  }

  async list(): Promise<UserRow[]> {
    return this.db
      .select()
      .from(t.users)
      .where(eq(t.users.organizationId, this.organizationId))
      .orderBy(asc(t.users.createdAt), asc(t.users.email));
  }

  async get(id: string): Promise<UserRow> {
    const row = (
      await this.db
        .select()
        .from(t.users)
        .where(and(eq(t.users.id, id), eq(t.users.organizationId, this.organizationId)))
        .limit(1)
    )[0];
    if (!row) throw new VeyraError('NOT_FOUND', 'User not found.');
    return row;
  }

  async create(
    input: { email: string; name: string; role: Role; password: string },
    ctx: SecurityContext,
  ): Promise<UserRow> {
    const email = normalizeEmail(input.email);
    if (!EMAIL.test(email) || email.length > 254)
      throw new VeyraError('INVALID_INPUT', 'Enter a valid email address.');
    const name = input.name.trim();
    if (!name || name.length > 120) throw new VeyraError('INVALID_INPUT', 'Enter a name.');
    if (!ROLES.includes(input.role)) throw new VeyraError('INVALID_INPUT', 'Choose a role.');
    const problem = passwordProblem(input.password);
    if (problem) throw new VeyraError('INVALID_INPUT', problem, { field: 'password' });
    const passwordHash = await hashPassword(input.password);
    const now = this.now();
    const row = {
      id: ulid(),
      email,
      name,
      role: input.role,
      active: true,
      organizationId: this.organizationId,
      passwordHash,
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await this.db
      .insert(t.users)
      .values(row)
      .onConflictDoNothing({ target: t.users.email })
      .returning();
    const user = inserted[0];
    if (!user) throw new VeyraError('CONFLICT', 'A user with this email address already exists.');
    await this.record('user.created', ctx, { role: user.role }, user.id);
    return user;
  }

  /**
   * Changes name, role or active. Disabling ends every session of the user at once. The last
   * active administrator can be neither disabled nor demoted (someone must be able to manage).
   */
  async update(
    id: string,
    patch: { name?: string; role?: Role; active?: boolean },
    ctx: SecurityContext,
  ): Promise<UserRow> {
    const user = await this.get(id);
    const role = patch.role ?? (user.role as Role);
    const active = patch.active ?? user.active;
    if (user.role === 'ADMIN' && user.active && (role !== 'ADMIN' || !active)) {
      const others = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(t.users)
        .where(
          and(
            eq(t.users.organizationId, this.organizationId),
            eq(t.users.role, 'ADMIN'),
            eq(t.users.active, true),
            ne(t.users.id, id),
          ),
        );
      if ((others[0]?.n ?? 0) === 0)
        throw new VeyraError(
          'INVALID_STATE',
          'This is the last active administrator. Make someone else an administrator first.',
        );
    }
    const name = patch.name?.trim() ?? user.name;
    if (!name || name.length > 120) throw new VeyraError('INVALID_INPUT', 'Enter a name.');
    const [updated] = await this.db
      .update(t.users)
      .set({ name, role, active, updatedAt: this.now() })
      .where(eq(t.users.id, id))
      .returning();
    if (!updated) throw new VeyraError('NOT_FOUND', 'User not found.');
    if (user.active && !active) {
      const revoked = await this.sessions.revokeAllForUser(id);
      await this.record('user.disabled', ctx, { sessionsRevoked: revoked }, id);
    } else if (!user.active && active) await this.record('user.enabled', ctx, {}, id);
    if (user.role !== role || user.name !== name)
      await this.record('user.updated', ctx, { roleFrom: user.role, roleTo: role }, id);
    return updated;
  }

  /**
   * Sets a new password. Every existing session of the user ends (a changed password must lock out
   * whoever knew the old one); the caller issues a fresh session when the user changed their own.
   */
  async setPassword(
    id: string,
    password: string,
    ctx: SecurityContext,
    event: 'password.changed' | 'password.reset',
  ): Promise<void> {
    const problem = passwordProblem(password);
    if (problem) throw new VeyraError('INVALID_INPUT', problem, { field: 'password' });
    await this.get(id);
    const now = this.now();
    await this.db
      .update(t.users)
      .set({ passwordHash: await hashPassword(password), passwordChangedAt: now, updatedAt: now })
      .where(eq(t.users.id, id));
    const revoked = await this.sessions.revokeAllForUser(id);
    await this.record(event, ctx, { sessionsRevoked: revoked }, id);
  }

  /**
   * Checks an email and password. Unknown account, disabled account, no password and wrong password
   * all take the same work (a hash is always verified) and give the same answer: null.
   */
  async authenticate(email: string, password: string): Promise<UserRow | null> {
    const normalized = normalizeEmail(email);
    const user = (
      await this.db.select().from(t.users).where(eq(t.users.email, normalized)).limit(1)
    )[0];
    const ok = await verifyPassword(user?.passwordHash ?? null, password);
    if (!user || !ok || !user.active || user.organizationId !== this.organizationId) return null;
    return user;
  }

  /** Looks up an account id by email (to attribute a failed sign-in), without revealing it. */
  async idOf(email: string): Promise<string | null> {
    return (
      (
        await this.db
          .select({ id: t.users.id })
          .from(t.users)
          .where(eq(t.users.email, normalizeEmail(email)))
          .limit(1)
      )[0]?.id ?? null
    );
  }

  async events(limit = 200) {
    return this.db
      .select({ e: t.securityEvents, name: t.users.name })
      .from(t.securityEvents)
      .leftJoin(t.users, eq(t.users.id, t.securityEvents.userId))
      .orderBy(desc(t.securityEvents.seq))
      .limit(limit);
  }
}
