import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER, can, isOpsPermission, type Permission } from '@veyra/shared';
import { PLATFORM_ORGANIZATION_ID } from '../db/schema';
import { safeEqual, type ActiveSession, type SessionStore } from '../auth/sessions';
import type { Users } from '../auth/users';
import { VeyraError } from '../workflow/veyra';

/**
 * Centralized access control (Phase 6C, docs/SECURITY.md "Authorization").
 *
 * Every route declares `config.access`:
 * - `'public'`: no session needed (the health probes, sign-in, the current-session probe);
 * - `'session'`: any signed-in, active user of this organization;
 * - a `Permission`: a signed-in user whose role grants it (packages/shared/src/auth.ts).
 *
 * A route without a declaration is a startup error (`onRoute` below), so a new endpoint cannot be
 * added unprotected by accident. The check runs in `onRequest`, before any body is read or parsed.
 *
 * CSRF (cookies authenticate, so a forged cross-site request would carry them): the session cookie
 * is SameSite=Strict, every state-changing request from a browser must come from an allowed
 * origin (Origin / Sec-Fetch-Site), and every state-changing request with a session must echo the
 * session's CSRF token in the `x-veyra-csrf` header (constant-time comparison).
 */
export type Access = 'public' | 'session' | Permission;

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyInstance {
    /** Every route and who may call it (./access.ts). */
    routeAccess: readonly RouteAccess[];
  }
  interface FastifyRequest {
    /** The signed-in session, resolved from the cookie (null: nobody). */
    auth: ActiveSession | null;
  }
}

export interface AccessOptions {
  sessions: SessionStore;
  users: Users;
  organizationId: string;
  cookieName: string;
  /** Origins a state-changing browser request may come from. */
  allowedOrigins: readonly string[];
  /** Sends a safe error body. */
  deny: (
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => FastifyReply;
}

/** `__Host-` binds the cookie to this exact origin (Secure, Path=/, no Domain) where possible. */
export const sessionCookieName = (secure: boolean): string =>
  secure ? '__Host-veyra_session' : 'veyra_session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isUnsafe = (method: string): boolean => !SAFE_METHODS.has(method);

/** A browser request that did not come from one of Veyra's own origins. */
export function crossOrigin(req: FastifyRequest, allowed: readonly string[]): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string') return !allowed.includes(origin);
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site' || site === 'same-site';
}

export interface RouteAccess {
  method: string;
  url: string;
  access: Access;
}

/**
 * Registers the declaration check. Call before any route is added. Returns the table of every
 * route and its access, filled as routes are added (tests walk it).
 */
export function requireAccessDeclarations(app: FastifyInstance): RouteAccess[] {
  const table: RouteAccess[] = [];
  app.addHook('onRoute', (route) => {
    // CORS preflight routes (registered by @fastify/cors) carry no body and no action.
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.every((m) => m === 'OPTIONS')) return;
    const access = (route.config as { access?: Access } | undefined)?.access;
    if (!access)
      throw new Error(
        `Route ${methods.join(',')} ${route.url} declares no access (config.access): every route must.`,
      );
    for (const method of methods) table.push({ method, url: route.url, access });
  });
  return table;
}

/** The permission check shared by the hook and handlers that need a second, finer check. */
export function requirePermission(req: FastifyRequest, permission: Permission): ActiveSession {
  const auth = req.auth;
  if (!auth) throw new VeyraError('FORBIDDEN', 'You do not have permission to do this.');
  if (!can(auth.user.role, permission))
    throw new VeyraError('FORBIDDEN', 'You do not have permission to do this.', { permission });
  return auth;
}

/** The signed-in user's id (routes that are not public always have one). */
export function actorOf(req: FastifyRequest): string {
  if (!req.auth) throw new VeyraError('FORBIDDEN', 'Sign in to continue.');
  return req.auth.user.id;
}

export function registerAccessControl(app: FastifyInstance, o: AccessOptions): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req, reply) => {
    const access = req.routeOptions.config.access;
    if (!access) return; // unknown route: the 404 handler answers
    const token = req.cookies[o.cookieName];
    // Health probes never touch sessions (they must answer while the database is down).
    if (req.routeOptions.url?.startsWith('/api/v1/health')) return;
    req.auth = token ? await o.sessions.resolve(token) : null;
    if (token && !req.auth) void reply.clearCookie(o.cookieName, { path: '/' });
    if (req.auth) req.log = req.log.child({ userId: req.auth.user.id });

    if (isUnsafe(req.method) && crossOrigin(req, o.allowedOrigins))
      return o.deny(req, reply, 403, 'CSRF_REJECTED', 'This request did not come from Veyrafy.');
    if (access === 'public') return;
    if (!req.auth) return o.deny(req, reply, 401, 'UNAUTHENTICATED', 'Sign in to continue.');
    // Two separate surfaces (Phase 8A). Veyra's operators (VEYRA_ADMIN, platform organization)
    // reach only Veyra Operations (ops permissions) and their own session; customer routes refuse
    // them. Customer users reach only their organization's routes; ops routes refuse them (they
    // have no ops permission, whatever their customer role).
    const operator =
      req.auth.user.role === 'VEYRA_ADMIN' &&
      req.auth.user.organizationId === PLATFORM_ORGANIZATION_ID;
    if (
      operator
        ? access !== 'session' && !isOpsPermission(access)
        : req.auth.user.organizationId !== o.organizationId
    )
      return o.deny(req, reply, 403, 'FORBIDDEN', 'You do not have permission to do this.');
    if (isUnsafe(req.method)) {
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(header, req.auth.csrfToken))
        return o.deny(
          req,
          reply,
          403,
          'CSRF_REJECTED',
          'Your session could not confirm this request. Reload the page and try again.',
        );
    }
    if (access !== 'session' && !can(req.auth.user.role, access)) {
      await o.users.record(
        'access.denied',
        { userId: req.auth.user.id, requestId: req.id },
        { method: req.method, route: req.routeOptions.url ?? '', permission: access },
      );
      return o.deny(req, reply, 403, 'FORBIDDEN', 'You do not have permission to do this.');
    }
  });
}
