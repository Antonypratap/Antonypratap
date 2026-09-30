import type { InjectOptions } from 'fastify';
import { CSRF_HEADER, type Role } from '@veyra/shared';
import type { createApp } from '../app';
import * as t from '../db/schema';
import { ulid } from '../ids';
import { DEMO_USER } from '../workflow/veyra';

type App = Awaited<ReturnType<typeof createApp>>;

export interface TestSession {
  userId: string;
  cookie: string;
  csrf: string;
  /** Cookie and CSRF headers for an inject call. */
  headers: Record<string, string>;
}

/**
 * Test-only: a signed-in session without going through the password sign-in (which the security
 * tests exercise themselves). Default: the demo's designated user, an ADMIN. With `role`, a new
 * active user of that role (no password) is created first.
 */
export async function testSession(
  app: App,
  opts: { role?: Role; userId?: string } = {},
): Promise<TestSession> {
  let userId = opts.userId ?? DEMO_USER.id;
  if (opts.role) {
    userId = ulid();
    const now = app.veyra.clock().toISOString();
    await app.veyra.db.insert(t.users).values({
      id: userId,
      name: `Test ${opts.role.toLowerCase()}`,
      email: `${opts.role.toLowerCase()}-${userId.toLowerCase()}@test.invalid`,
      active: true,
      // Veyra's operators live in the platform organization (Phase 8A).
      organizationId:
        opts.role === 'VEYRA_ADMIN' ? t.PLATFORM_ORGANIZATION_ID : app.veyra.organizationId,
      role: opts.role,
      passwordHash: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  const { token, csrfToken } = await app.sessions.create(userId);
  const cookie = `${app.cookieName}=${token}`;
  return { userId, cookie, csrf: csrfToken, headers: { cookie, [CSRF_HEADER]: csrfToken } };
}

/**
 * Test-only: makes `app.server.inject` send the session's cookie and CSRF header on every call
 * that does not set its own cookie, so the workflow tests exercise the real, protected routes.
 * `anonymous` is the untouched inject.
 */
export function injectAs(app: App, session: TestSession): App['server']['inject'] {
  const server = app.server;
  const anonymous = server.inject.bind(server);
  const signed = ((opts?: InjectOptions | string) => {
    if (opts === undefined) return anonymous();
    const o: InjectOptions = typeof opts === 'string' ? { url: opts } : opts;
    const headers = { ...(o.headers ?? {}) } as Record<string, string>;
    if (!('cookie' in headers)) Object.assign(headers, session.headers);
    return anonymous({ ...o, headers });
  }) as App['server']['inject'];
  server.inject = signed;
  return anonymous;
}
