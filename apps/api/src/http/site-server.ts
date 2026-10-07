import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { pino, type Logger } from 'pino';
import { z } from 'zod';
import { BLOG_LIMITS, ROLE_PERMISSIONS } from '@veyra/shared';
import { ulid } from '../ids';
import { PLATFORM_ORGANIZATION_ID } from '../db/schema';
import type { SessionStore } from '../auth/sessions';
import type { Users } from '../auth/users';
import { buildBlogAssets } from '../blog/assets';
import { registerBlogRoutes } from '../blog/routes';
import type { BlogService } from '../blog/service';
import { VeyraError } from '../workflow/veyra';
import { registerAccessControl, requireAccessDeclarations, sessionCookieName } from './access';
import { registerAuthRoutes } from './auth-routes';
import { RateLimiter, bucketOf } from './rate-limit';
import { registerSecurityHeaders } from './security-headers';
import { registerWebApp, type WebFiles } from './web-static';

/**
 * The public website (veyrafy.com), VEYRA_SITE_ONLY=true: the built web app and its security
 * headers. Without the blog it has no database, storage, ERP connector, sign-in, sessions or jobs;
 * it cannot, because none of those are built here. `/api/*` answers only the liveness probes and a
 * health line with the deployed commit; everything else there is a 404 (so a client address that
 * lands here is shown "This Veyrafy address isn't set up." by the web app).
 *
 * With the blog (VEYRA_BLOG=true, docs/BLOG.md) it also serves the blog's pages from its own
 * database, and the publishing studio's API for Veyrafy's editors (VEYRA_ADMIN accounts of the
 * platform organization) with the application's own sign-in, CSRF and access control. Still no
 * customer data, ERP, documents or jobs.
 */
export interface SiteBlog {
  service: BlogService;
  sessions: SessionStore;
  users: Users;
  cookieSecure: boolean;
  /** Where editors open the studio; state-changing requests from elsewhere are refused. */
  publicOrigins: readonly string[];
  /** The canonical origin of public pages (https://veyrafy.com). */
  origin: string;
  loginPerMinute: number;
  /** How often scheduled articles are marked published (ms; 0: never, for tests). */
  promoteEveryMs?: number;
}

const STATUS: Record<VeyraError['code'], number> = {
  NOT_FOUND: 404,
  DUPLICATE_UPLOAD: 409,
  INVALID_STATE: 409,
  INVALID_INPUT: 422,
  UNSUPPORTED_FILE: 415,
  FORBIDDEN: 403,
  CONFLICT: 409,
  LIMIT_REACHED: 409,
  RATE_LIMITED: 429,
};

/** index.html with the Search Console verification tag (public), when one is configured. */
function withVerification(web: WebFiles, token: string | null): WebFiles {
  if (!token) return web;
  const tag = `<meta name="google-site-verification" content="${token}" />`;
  const body = Buffer.from(
    web.index.body.toString('utf8').replace('</head>', `${tag}\n</head>`),
    'utf8',
  );
  const index = { ...web.index, body };
  const files = new Map(web.files);
  files.set('/index.html', index);
  return { files, index };
}

export async function buildSiteServer(options: {
  web: WebFiles;
  hsts: boolean;
  release: string | null;
  trustProxy?: number;
  log?: Logger;
  analytics?: { ga4MeasurementId: string | null; gscVerification: string | null };
  blog?: SiteBlog | null;
}): Promise<FastifyInstance> {
  const hops = options.trustProxy ?? 0;
  const blog = options.blog ?? null;
  const web = withVerification(options.web, options.analytics?.gscVerification ?? null);
  const app = Fastify({
    loggerInstance: (options.log ?? pino({ level: 'silent' })) as FastifyBaseLogger,
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
    genReqId: () => ulid(),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
  });
  // With the blog, every route must declare who may call it (as in the application).
  if (blog) app.decorate('routeAccess', requireAccessDeclarations(app));
  await registerSecurityHeaders(app, { hsts: options.hsts });
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });
  const limiter = new RateLimiter({
    upload: 30,
    processing: 120,
    dev: 1,
    login: blog?.loginPerMinute ?? 10,
  });
  const error = (
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    requestId?: string,
  ) => ({
    error: { code, message, details, ...(requestId ? { requestId } : {}) },
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
    const bucket = blog ? bucketOf(req.method, req.routeOptions.url) : null;
    if (!bucket) return;
    const retryAfter = limiter.hit(bucket, req.ip);
    if (retryAfter !== null)
      return reply
        .status(429)
        .header('retry-after', String(retryAfter))
        .send(
          error(
            'RATE_LIMITED',
            'Too many requests. Wait a moment and try again.',
            { retryAfterSeconds: retryAfter },
            req.id,
          ),
        );
  });
  const PUBLIC = { config: { access: 'public' } } as const;
  app.get('/api/v1/health/live', PUBLIC, async () => ({ status: 'ok' }));
  app.get('/api/v1/health', PUBLIC, async () => ({
    ok: true,
    site: true,
    // Present only when the blog is on: the static website's answer is unchanged.
    ...(blog ? { blog: true } : {}),
    version: options.release,
  }));
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'There is no such endpoint.', requestId: req.id },
    }),
  );

  if (blog) {
    await app.register(cookie);
    await app.register(multipart, {
      limits: { fileSize: BLOG_LIMITS.mediaBytes, files: 1, fields: 2, parts: 3 },
    });
    const cookieName = sessionCookieName(blog.cookieSecure);
    registerAccessControl(app, {
      sessions: blog.sessions,
      users: blog.users,
      organizationId: PLATFORM_ORGANIZATION_ID,
      cookieName,
      allowedOrigins: blog.publicOrigins,
      deny: (req, reply, status, code, message) =>
        reply.status(status).send(error(code, message, {}, req.id)),
    });
    app.setErrorHandler((err: FastifyError | Error, req, reply) => {
      if (err instanceof VeyraError) {
        if (err.code === 'FORBIDDEN' && req.auth)
          void blog.users
            .record(
              'access.denied',
              { userId: req.auth.user.id, requestId: req.id },
              { method: req.method, route: req.routeOptions.url ?? '' },
            )
            .catch(() => undefined);
        return reply
          .status(STATUS[err.code])
          .send(error(err.code, err.message, err.details, req.id));
      }
      if (err instanceof z.ZodError)
        return reply
          .status(422)
          .send(
            error(
              'VALIDATION',
              'The request is not valid.',
              { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
              req.id,
            ),
          );
      if ('code' in err && err.code === 'FST_REQ_FILE_TOO_LARGE')
        return reply
          .status(413)
          .send(error('TOO_LARGE', 'Images up to 8 MB are accepted.', {}, req.id));
      const status = (err as FastifyError).statusCode;
      if (status !== undefined && status >= 400 && status < 500)
        return reply
          .status(status)
          .send(error('BAD_REQUEST', 'The request could not be read.', {}, req.id));
      req.log.error({ err }, 'unhandled error');
      return reply.status(500).send(error('INTERNAL', 'Something went wrong.', {}, req.id));
    });
    registerAuthRoutes(app, {
      sessions: blog.sessions,
      users: blog.users,
      cookieName,
      cookieSecure: blog.cookieSecure,
      limiter,
      tooMany: (req, reply, retryAfter) =>
        reply
          .status(429)
          .header('retry-after', String(retryAfter))
          .send(
            error(
              'RATE_LIMITED',
              'Too many requests. Wait a moment and try again.',
              { retryAfterSeconds: retryAfter },
              req.id,
            ),
          ),
      error,
      sessionView: (auth) => ({
        authenticated: true,
        demoSignIn: false,
        user: {
          id: auth.user.id,
          name: auth.user.name,
          email: auth.user.email,
          role: auth.user.role,
        },
        permissions: [...ROLE_PERMISSIONS[auth.user.role]],
        organization: { id: PLATFORM_ORGANIZATION_ID, name: 'Veyrafy Operations' },
        csrfToken: auth.csrfToken,
        expiresAt: auth.expiresAt,
      }),
      demo: null,
    });
    registerBlogRoutes(app, {
      blog: blog.service,
      assets: buildBlogAssets(web),
      origin: blog.origin,
      ga4: options.analytics?.ga4MeasurementId ?? null,
      gscVerification: options.analytics?.gscVerification ?? null,
      limiter,
      cookieSecure: blog.cookieSecure,
    });
    // Scheduled articles are public from their time on (decided when read); this only records it.
    const every = blog.promoteEveryMs ?? 60_000;
    if (every > 0) {
      const timer = setInterval(() => {
        void blog.service
          .promoteDue()
          .catch((e: unknown) => app.log.warn({ err: e }, 'scheduled publishing check failed'));
      }, every);
      timer.unref();
      app.addHook('onClose', async () => clearInterval(timer));
    }
  }
  registerWebApp(app, web, { indexable: true });
  return app;
}
