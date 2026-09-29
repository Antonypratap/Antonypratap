import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Role } from '@veyra/shared';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';

/**
 * Server-side sessions (Phase 6C).
 *
 * - The token is 32 random bytes (base64url) from the OS CSPRNG. It lives only in an HttpOnly
 *   cookie; the database stores its SHA-256, never the token.
 * - A session ends at the first of: sign-out (revoked), `idleMs` without a request, `absoluteMs`
 *   after sign-in, the user being disabled, or the user's password changing.
 * - Each session has its own CSRF synchronizer token (sent back by the browser in a header on every
 *   state-changing request).
 * - Several sessions per user are allowed (several browsers); each is independent and each can be
 *   revoked. Disabling a user or changing their password revokes all of them.
 */
export interface SessionPolicy {
  idleMs: number;
  absoluteMs: number;
}

export interface ActiveSession {
  tokenHash: string;
  csrfToken: string;
  expiresAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: Role;
    organizationId: string;
  };
}

/** Only this many characters ever reach a lookup: anything longer is not a token. */
const TOKEN_LENGTH = 43;

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export const newToken = (): string => randomBytes(32).toString('base64url');

/** Constant-time comparison of two strings (e.g. the CSRF header and the session's token). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** How often `last_seen_at` is written (not on every request). */
const TOUCH_EVERY_MS = 60_000;

export class SessionStore {
  constructor(
    readonly db: VeyraDb,
    readonly policy: SessionPolicy,
    readonly clock: () => Date = () => new Date(),
  ) {}

  /** A new session for the user. Returns the token for the cookie (never stored). */
  async create(userId: string): Promise<{ token: string; csrfToken: string; expiresAt: string }> {
    const token = newToken();
    const csrfToken = newToken();
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.policy.absoluteMs).toISOString();
    await this.db.insert(t.sessions).values({
      tokenHash: hashToken(token),
      userId,
      csrfToken,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt,
      revokedAt: null,
    });
    return { token, csrfToken, expiresAt };
  }

  /** The live session for a cookie token, or null (unknown, revoked, expired, idle, disabled user). */
  async resolve(token: string | undefined): Promise<ActiveSession | null> {
    if (!token || token.length !== TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const tokenHash = hashToken(token);
    const row = (
      await this.db
        .select({ s: t.sessions, u: t.users })
        .from(t.sessions)
        .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
        .where(and(eq(t.sessions.tokenHash, tokenHash), isNull(t.sessions.revokedAt)))
        .limit(1)
    )[0];
    if (!row) return null;
    const now = this.clock().getTime();
    const idleUntil = Date.parse(row.s.lastSeenAt) + this.policy.idleMs;
    if (!row.u.active || now >= Date.parse(row.s.expiresAt) || now >= idleUntil) {
      await this.revokeHash(tokenHash);
      return null;
    }
    // Written at most every minute (never less often than a tenth of the idle time).
    if (now - Date.parse(row.s.lastSeenAt) > Math.min(TOUCH_EVERY_MS, this.policy.idleMs / 10))
      await this.db
        .update(t.sessions)
        .set({ lastSeenAt: new Date(now).toISOString() })
        .where(eq(t.sessions.tokenHash, tokenHash));
    return {
      tokenHash,
      csrfToken: row.s.csrfToken,
      expiresAt: row.s.expiresAt,
      user: {
        id: row.u.id,
        name: row.u.name,
        email: row.u.email,
        // The column's check constraint admits only the three roles.
        role: row.u.role as Role,
        organizationId: row.u.organizationId,
      },
    };
  }

  async revoke(token: string | undefined): Promise<void> {
    if (token && token.length === TOKEN_LENGTH) await this.revokeHash(hashToken(token));
  }

  async revokeHash(tokenHash: string): Promise<void> {
    await this.db
      .update(t.sessions)
      .set({ revokedAt: this.clock().toISOString() })
      .where(and(eq(t.sessions.tokenHash, tokenHash), isNull(t.sessions.revokedAt)));
  }

  /** Ends every session of a user (disabled, password changed, compromise response). */
  async revokeAllForUser(userId: string): Promise<number> {
    const rows = await this.db
      .update(t.sessions)
      .set({ revokedAt: this.clock().toISOString() })
      .where(and(eq(t.sessions.userId, userId), isNull(t.sessions.revokedAt)))
      .returning({ h: t.sessions.tokenHash });
    return rows.length;
  }
}
