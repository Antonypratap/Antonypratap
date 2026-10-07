import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiLoginBodySchema, ApiSessionSchema, type ApiSession } from '@veyra/shared';
import { safeEqual, type ActiveSession, type SessionStore } from '../auth/sessions';
import { normalizeEmail, type Users } from '../auth/users';
import { verifyPassword } from '../auth/passwords';
import type { Secret } from '../secret';
import { VeyraError } from '../workflow/veyra';
import { actorOf } from './access';
import type { RateLimiter } from './rate-limit';

/**
 * Sign-in and sessions (Phase 6C), shared by every Veyrafy server that has accounts: a client or
 * demo instance (server.ts) and the website's blog studio (site-server.ts). One implementation, so
 * the rules are the same everywhere: the session token only in an HttpOnly, SameSite=Strict
 * cookie; per-account and per-address sign-in limits; one answer for every failed sign-in; a new
 * session (and a new CSRF token) after sign-in and after a password change.
 */
export interface AuthRouteOptions {
  sessions: SessionStore;
  users: Users;
  cookieName: string;
  cookieSecure: boolean;
  limiter: RateLimiter;
  tooMany: (req: FastifyRequest, reply: FastifyReply, retryAfter: number) => FastifyReply;
  error: (
    code: string,
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) => unknown;
  /** The signed-in session as the web app sees it. */
  sessionView: (auth: ActiveSession) => ApiSession;
  /** Demo only (never production): the PIN and the user it signs in as. */
  demo: { pin: Secret; userId: string } | null;
}

/** Sign-in routes: responses carry the CSRF token, so they are never compressed. */
const AUTH_PUBLIC = { config: { access: 'public' }, compress: false } as const;
const AUTH_SESSION = { config: { access: 'session' }, compress: false } as const;

export function registerAuthRoutes(app: FastifyInstance, o: AuthRouteOptions): void {
  const { sessions, users, cookieName, limiter, tooMany, error, sessionView } = o;
  const send = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => schema.parse(value);
  const ctx = (req: FastifyRequest) => ({ userId: req.auth?.user.id ?? null, requestId: req.id });
  const cookieOptions = (expiresAt: string) => ({
    httpOnly: true,
    secure: o.cookieSecure,
    sameSite: 'strict' as const,
    path: '/',
    expires: new Date(expiresAt),
  });
  /** A new session (after sign-in or a password change): the old one, if any, ends first. */
  const startSession = async (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    if (req.auth) await sessions.revokeHash(req.auth.tokenHash);
    else await sessions.revoke(req.cookies[cookieName]);
    const created = await sessions.create(userId);
    void reply.setCookie(cookieName, created.token, cookieOptions(created.expiresAt));
    const auth = await sessions.resolve(created.token);
    if (!auth) throw new Error('new session did not resolve');
    return auth;
  };
  const demoPin = o.demo?.pin ?? null;

  app.get('/api/v1/auth/session', AUTH_PUBLIC, async (req) =>
    send(
      ApiSessionSchema,
      req.auth ? sessionView(req.auth) : { authenticated: false, demoSignIn: demoPin !== null },
    ),
  );

  app.post('/api/v1/auth/login', AUTH_PUBLIC, async (req, reply) => {
    const body = ApiLoginBodySchema.parse(req.body ?? {});
    // Per account as well as per address: guessing one account's password from many addresses.
    const retryAfter = limiter.hit('login', `account:${normalizeEmail(body.email)}`);
    if (retryAfter !== null) return tooMany(req, reply, retryAfter);
    const user = await users.authenticate(body.email, body.password);
    if (!user) {
      await users.record(
        'login.failed',
        { userId: null, requestId: req.id },
        { method: 'password' },
        await users.idOf(body.email),
      );
      // One answer for unknown account, wrong password and disabled account.
      return reply
        .status(401)
        .send(error('INVALID_CREDENTIALS', 'The email or password is not correct.', {}, req.id));
    }
    const auth = await startSession(req, reply, user.id);
    await users.record(
      'login.succeeded',
      { userId: user.id, requestId: req.id },
      { method: 'password' },
    );
    return send(ApiSessionSchema, sessionView(auth));
  });

  // Demo only (never production): the demo PIN opens a session as the demo's designated user.
  if (o.demo) {
    const { pin: secret, userId } = o.demo;
    app.post('/api/v1/auth/demo', AUTH_PUBLIC, async (req, reply) => {
      const { pin } = z.object({ pin: z.string().max(32) }).parse(req.body ?? {});
      if (!safeEqual(pin, secret.reveal())) {
        await users.record(
          'login.failed',
          { userId: null, requestId: req.id },
          { method: 'demo_pin' },
        );
        return reply
          .status(401)
          .send(error('INVALID_CREDENTIALS', 'That PIN isn’t correct.', {}, req.id));
      }
      const auth = await startSession(req, reply, userId);
      await users.record('login.succeeded', { userId, requestId: req.id }, { method: 'demo_pin' });
      return send(ApiSessionSchema, sessionView(auth));
    });
  }

  app.post('/api/v1/auth/logout', AUTH_SESSION, async (req, reply) => {
    const auth = req.auth;
    if (auth) {
      await sessions.revokeHash(auth.tokenHash);
      await users.record('logout', ctx(req));
    }
    void reply.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  });

  app.post('/api/v1/auth/password', AUTH_SESSION, async (req, reply) => {
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string().max(1024), newPassword: z.string().max(1024) })
      .parse(req.body ?? {});
    const me = await users.get(actorOf(req));
    if (!(await verifyPassword(me.passwordHash, currentPassword)))
      throw new VeyraError('INVALID_INPUT', 'The current password is not correct.', {
        field: 'currentPassword',
      });
    await users.setPassword(me.id, newPassword, ctx(req), 'password.changed');
    // Every session ended with the change; this browser continues on a fresh one.
    req.auth = null;
    return send(ApiSessionSchema, sessionView(await startSession(req, reply, me.id)));
  });
}
