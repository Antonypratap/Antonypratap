import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import multipart from '@fastify/multipart';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiAnswerBodySchema,
  ApiInstanceSchema,
  ApiLoginBodySchema,
  ApiSecurityEventSchema,
  ApiSessionSchema,
  ApiUserSchema,
  type Permission,
  ApiCapabilitiesSchema,
  CUSTOMER_ROLES,
  ROLE_PERMISSIONS,
  type ApiSession,
  ApiAuditEntrySchema,
  ApiDemoScenarioSchema,
  ApiErpSchema,
  ApiImportSchema,
  ApiInboxSchema,
  ApiInvoiceDetailSchema,
  ApiQuestionSchema,
  MAX_UPLOAD_BYTES,
  formatInr,
  formatQty,
  milliQty,
  paise,
} from '@veyra/shared';
import { renderPdfPage, uprightImage } from '@veyra/extractor';
import { stateName } from '@veyra/india-tax';
import {
  CAPABILITY_LABEL,
  ERP_CAPABILITIES,
  describeConnection,
  isErpConnectorError,
} from '@veyra/erp-connector';
import * as t from '../db/schema';
import { InvalidTransitionError } from '../workflow/state-machine';
import { DEMO_USER, VeyraError, uploadLimitText, type Veyra } from '../workflow/veyra';
import { safeEqual, type ActiveSession, type SessionStore } from '../auth/sessions';
import { normalizeEmail, type Users } from '../auth/users';
import { verifyPassword } from '../auth/passwords';
import type { Secret } from '../secret';
import {
  actorOf,
  registerAccessControl,
  requireAccessDeclarations,
  requirePermission,
  sessionCookieName,
} from './access';
import { DEMO_SCENARIOS, startScenario, type DemoBusiness } from '../demo/scenarios';
import { Presenter } from './present';
import { isStorageError } from '../storage';
import { BusinessImports } from '../imports/service';
import { templateFiles, templateWorkbook } from '../imports/templates';
import { MAX_IMPORT_FILES } from '../imports/validate';
import type { Environment } from '../config';
import { ulid } from '../ids';
import { pino, type Logger } from 'pino';
import { RateLimiter, bucketOf, type RateBucket } from './rate-limit';
import { registerChallengeRoutes } from '../challenge/routes';
import type { ChallengeService } from '../challenge/service';
import { publicReadiness, type ReadinessReport } from './health';
import { timedScope } from '../perf/timing';
import { CommercialAdmin } from '../commercial/admin';
import { LimitReachedError, NotEntitledError } from '../commercial/entitlements';
import { usageOf, usedFor } from '../commercial/usage';
import { registerOps } from './ops';
import { registerSecurityHeaders } from './security-headers';
import { registerWebApp, type WebFiles } from './web-static';
import {
  auditTable,
  businessRecordsXlsx,
  decisionsTable,
  invoicesTable,
  tableCsv,
  tableXlsx,
} from '../exports/service';

export interface ServerOptions {
  veyra: Veyra;
  /** The AI reader, when one is configured: "Test the reader" asks it a tiny question. */
  aiReader?: {
    /** Model names, main first (System Configuration; never the key). */
    readonly models?: readonly string[];
    test(): Promise<{
      ok: boolean;
      ms: number;
      model: string;
      reason: string | null;
      skipped: string[];
    }>;
  } | null;
  /**
   * Dev only: wipe Veyra's data and reset the ERP to the DEMO.md seed, or to an empty business
   * (company only) to try importing business records. Never registered in production.
   */
  resetDemo?: (erp: 'demo' | 'empty') => Promise<void>;
  /** Which sample business the demo scenarios' documents belong to (default manufacturing). */
  demoBusiness?: DemoBusiness;
  /** Phase 6: which deployment this is. Dev and demo routes never exist in production. */
  environment?: Environment;
  /** Structured logger (one line per request). Absent: no request logs. */
  log?: Logger;
  limits?: { maxUploadBytes: number; maxJsonBodyBytes: number };
  rateLimits?: Record<RateBucket, number>;
  /** Proxy hops trusted for the client address. */
  trustProxy?: number;
  /** Readiness of the instance's dependencies (GET /api/v1/health/ready). */
  readiness?: () => Promise<ReadinessReport>;
  /** Veyra Operations' commercial actions (Phase 8A). Absent: built on the Veyrafy's own. */
  commercial?: CommercialAdmin;
  /** The 5 Invoice Challenge (acquisition); absent: its routes do not exist. */
  challenge?: ChallengeService | null;
  /**
   * The built web app, served from this same origin (production client instances). Absent: the
   * API serves /api only (development uses the Vite dev server).
   */
  web?: WebFiles | null;
  /** The deployed commit (RAILWAY_GIT_COMMIT_SHA), shown by GET /api/v1/health. */
  release?: string | null;
  /** Sign-in, sessions and browser origins (Phase 6C). */
  auth: {
    sessions: SessionStore;
    users: Users;
    /** Secure cookie (HTTPS only). Always in production. */
    cookieSecure: boolean;
    /** Demo sign-in PIN; the demo sign-in exists only with it, never in production. */
    demoPin?: Secret | null;
    /** Where users open Veyra; state-changing browser requests from elsewhere are refused. */
    publicOrigins: readonly string[];
    /** Other origins allowed to call the API with credentials (CORS). Empty: no CORS. */
    corsOrigins?: readonly string[];
  };
}

/**
 * An incoming `x-request-id` is reused only from a trusted reverse proxy (VEYRA_TRUST_PROXY > 0)
 * and only when it looks like an id; otherwise Veyra generates one. Never arbitrary text in logs.
 */
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

const Id = z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });

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

/** Browser features the API and documents never need (Permissions-Policy; helmet has none). */
const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()';

/**
 * The REST API (/api/v1). Every request body is validated with Zod; every response is validated
 * against the shared contract before it is sent. Every route declares who may call it and the
 * server enforces it (./access.ts); the acting user is always the signed-in session's user.
 */
export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { veyra } = options;
  const environment = options.environment ?? 'development';
  const present = new Presenter(veyra);
  const maxUploadBytes = Math.min(
    options.limits?.maxUploadBytes ?? MAX_UPLOAD_BYTES,
    MAX_UPLOAD_BYTES,
  );
  const hops = options.trustProxy ?? 0;
  const { sessions, users } = options.auth;
  const demoPin = environment === 'production' ? null : (options.auth.demoPin ?? null);
  const cookieName = sessionCookieName(options.auth.cookieSecure);
  const corsOrigins = [...(options.auth.corsOrigins ?? [])];
  const allowedOrigins = [...options.auth.publicOrigins, ...corsOrigins];
  const app = Fastify({
    loggerInstance: (options.log ?? pino({ level: 'silent' })) as FastifyBaseLogger,
    bodyLimit: options.limits?.maxJsonBodyBytes ?? 1024 * 1024,
    // Trust exactly the configured number of proxy hops for the client address (rate limits).
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
    // Our own per-request line (below) replaces Fastify's two.
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: (req) => {
      const given = hops > 0 ? req.headers['x-request-id'] : undefined;
      return typeof given === 'string' && REQUEST_ID.test(given) ? given : ulid();
    },
  });
  app.decorate('routeAccess', requireAccessDeclarations(app));
  await app.register(cookie);
  await registerSecurityHeaders(app, { hsts: options.auth.cookieSecure });
  // Response compression (Phase 7): JSON and CSV lists shrink several times over the network.
  // Only compressible types (never PDFs, images or XLSX, which are compressed already), only above
  // 1 KB, and never the sign-in responses, which carry the session's CSRF token (compressing a
  // secret next to attacker-influenced data is what BREACH-style attacks exploit).
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });
  // CORS only for explicitly configured other origins (never "*"); same-origin needs none.
  if (corsOrigins.length > 0)
    await app.register(cors, {
      origin: corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH'],
      allowedHeaders: ['content-type', 'x-veyra-csrf'],
      exposedHeaders: ['x-request-id', 'retry-after'],
      maxAge: 600,
    });
  // Invoice uploads take one file; business-record imports up to 8 (each ≤ 5 MB, checked).
  await app.register(multipart, {
    limits: {
      fileSize: maxUploadBytes,
      files: MAX_IMPORT_FILES,
      fields: 0,
      parts: MAX_IMPORT_FILES,
    },
  });
  const imports = new BusinessImports(veyra);
  const rateLimits = options.rateLimits ?? { upload: 60, processing: 120, dev: 60, login: 10 };
  const limiter = new RateLimiter(rateLimits);

  const send = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => schema.parse(value);
  const error = (
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    requestId?: string,
  ) => ({
    error: { code, message, details, ...(requestId ? { requestId } : {}) },
  });

  const tooMany = (req: FastifyRequest, reply: FastifyReply, retryAfter: number) => {
    reply.header('retry-after', String(retryAfter));
    return reply
      .status(429)
      .send(
        error(
          'RATE_LIMITED',
          'Too many requests. Wait a moment and try again.',
          { retryAfterSeconds: retryAfter },
          req.id,
        ),
      );
  };

  // Every response carries its request id, for support and log correlation.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('permissions-policy', PERMISSIONS_POLICY);
    // Nothing the API returns may be kept by a shared or browser cache.
    reply.header('cache-control', 'no-store');
    const bucket = bucketOf(req.method, req.routeOptions.url);
    if (!bucket) return;
    const retryAfter = limiter.hit(bucket, req.ip);
    if (retryAfter !== null) return tooMany(req, reply, retryAfter);
  });
  // Authentication, CSRF and authorization for every route, from its declared access.
  // A suspended customer (Veyrafy Operations) is refused; read at most every 15 seconds.
  let suspendedAt = 0;
  let suspendedNow = false;
  const suspended = async (): Promise<boolean> => {
    if (Date.now() - suspendedAt < 15_000) return suspendedNow;
    const row = (
      await veyra.db
        .select({ s: t.organizations.commercialStatus })
        .from(t.organizations)
        .where(eq(t.organizations.id, veyra.organizationId))
        .limit(1)
    )[0];
    suspendedNow = row?.s === 'suspended';
    suspendedAt = Date.now();
    return suspendedNow;
  };
  /** After a suspension or reactivation: the next request reads the status afresh. */
  const suspensionChanged = (): void => {
    suspendedAt = 0;
  };
  registerAccessControl(app, {
    sessions,
    users,
    suspended,
    organizationId: veyra.organizationId,
    cookieName,
    allowedOrigins,
    deny: (req, reply, status, code, message) =>
      reply.status(status).send(error(code, message, {}, req.id)),
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? null;
    const line = {
      method: req.method,
      route,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    };
    // Health checks are polled constantly: debug only.
    // Health probes and the web app's own files are routine: debug only, so logs stay readable.
    if (route?.startsWith('/api/v1/health') || (route === '/*' && reply.statusCode < 400))
      req.log.debug(line, 'request');
    else if (reply.statusCode >= 500) req.log.error(line, 'request');
    else req.log.info(line, 'request');
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send(error('NOT_FOUND', 'There is no such endpoint.', {}, req.id)),
  );

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    const e = (code: string, message: string, details: Record<string, unknown> = {}) =>
      error(code, message, details, req.id);
    if (err instanceof VeyraError) {
      if (err.code === 'FORBIDDEN' && req.auth)
        void users
          .record(
            'access.denied',
            { userId: req.auth.user.id, requestId: req.id },
            { method: req.method, route: req.routeOptions.url ?? '' },
          )
          .catch(() => undefined);
      return reply.status(STATUS[err.code]).send(e(err.code, err.message, err.details));
    }
    // Commercial refusals (Phase 8A): a business answer, never plan or implementation detail.
    if (err instanceof NotEntitledError || err instanceof LimitReachedError)
      return reply.status(403).send(e(err.code, err.message));
    if (err instanceof InvalidTransitionError)
      return reply.status(409).send(e(err.code, err.message));
    if (err instanceof z.ZodError)
      return reply.status(422).send(
        e('VALIDATION', 'The request is not valid.', {
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      );
    if ('code' in err && err.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply
        .status(413)
        .send(e('TOO_LARGE', `Files up to ${uploadLimitText(maxUploadBytes)} are accepted.`));
    // ERP failures carry only a stable code and a safe message: never the underlying error.
    if (isErpConnectorError(err))
      return err.retryable
        ? reply.status(503).send(e('ERP_UNAVAILABLE', 'Your ERP could not be reached.'))
        : reply.status(502).send(e(`ERP_${err.code}`, err.userMessage));
    if (isStorageError(err)) {
      req.log.error({ errorCode: err.code }, 'document storage error');
      return err.code === 'STORAGE_NOT_FOUND' || err.code === 'STORAGE_INVALID_KEY'
        ? reply.status(404).send(e('NOT_FOUND', 'The document file is not available.'))
        : reply
            .status(err.retryable ? 503 : 500)
            .send(e(err.code, 'Documents cannot be read right now.'));
    }
    // Fastify's own client errors (malformed JSON, body too large, wrong content type, …): a
    // stable code and a fixed message, never the parser's text.
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      const [code, message] =
        status === 413
          ? ['TOO_LARGE', 'The request is too large.']
          : status === 415
            ? ['UNSUPPORTED_MEDIA_TYPE', 'This content type is not accepted.']
            : status === 406 || status === 429
              ? ['BAD_REQUEST', 'The request could not be handled.']
              : ['BAD_REQUEST', 'The request could not be read.'];
      return reply.status(status).send(e(code, message));
    }
    // Everything else is internal: logged in full server-side, a generic answer to the client.
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(e('INTERNAL', 'Something went wrong.'));
  });

  const PUBLIC = { config: { access: 'public' } } as const;
  const SESSION = { config: { access: 'session' } } as const;
  /** Sign-in routes: responses carry the CSRF token, so they are never compressed. */
  const AUTH_PUBLIC = { ...PUBLIC, compress: false } as const;
  const AUTH_SESSION = { ...SESSION, compress: false } as const;
  const may = (access: Permission) => ({ config: { access } });

  // ── Sign-in and sessions (Phase 6C) ──────────────────────────────────────
  const cookieOptions = (expiresAt: string) => ({
    httpOnly: true,
    secure: options.auth.cookieSecure,
    sameSite: 'strict' as const,
    path: '/',
    expires: new Date(expiresAt),
  });
  const ctx = (req: FastifyRequest) => ({ userId: req.auth?.user.id ?? null, requestId: req.id });
  const sessionView = (auth: ActiveSession): ApiSession => ({
    authenticated: true,
    demoSignIn: demoPin !== null,
    user: {
      id: auth.user.id,
      name: auth.user.name,
      email: auth.user.email,
      role: auth.user.role,
    },
    // Demo tooling is only offered where it exists.
    permissions: ROLE_PERMISSIONS[auth.user.role].filter(
      (p) => p !== 'demo.manage' || options.resetDemo !== undefined,
    ),
    // Veyra's operators belong to the platform organization, not to the customer's.
    organization:
      auth.user.organizationId === t.PLATFORM_ORGANIZATION_ID
        ? { id: t.PLATFORM_ORGANIZATION_ID, name: 'Veyrafy Operations' }
        : { id: veyra.organizationId, name: veyra.organizationName },
    csrfToken: auth.csrfToken,
    expiresAt: auth.expiresAt,
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

  // Which Veyrafy instance answers at this address: the organization's display name and whether it
  // is the demo, nothing else (ApiInstanceSchema is strict). The web app uses it to confirm that a
  // client address is set up. Authorization never depends on it: it is the configured
  // organization, and every protected route checks the signed-in session.
  app.get('/api/v1/instance', PUBLIC, async () =>
    send(ApiInstanceSchema, { name: veyra.organizationName, demo: demoPin !== null }),
  );

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
  if (demoPin) {
    app.post('/api/v1/auth/demo', AUTH_PUBLIC, async (req, reply) => {
      const { pin } = z.object({ pin: z.string().max(32) }).parse(req.body ?? {});
      if (!safeEqual(pin, demoPin.reveal())) {
        await users.record(
          'login.failed',
          { userId: null, requestId: req.id },
          { method: 'demo_pin' },
        );
        return reply
          .status(401)
          .send(error('INVALID_CREDENTIALS', 'That PIN isn’t correct.', {}, req.id));
      }
      const auth = await startSession(req, reply, DEMO_USER.id);
      await users.record(
        'login.succeeded',
        { userId: DEMO_USER.id, requestId: req.id },
        { method: 'demo_pin' },
      );
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

  // ── Users and the security audit trail (ADMIN) ───────────────────────────
  const userDto = (u: Awaited<ReturnType<Users['get']>>) =>
    ApiUserSchema.parse({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      canSignIn: u.passwordHash !== null,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    });
  // The product manages customer accounts only: VEYRA_ADMIN is created on the server (CLI).
  const Role = z.enum(CUSTOMER_ROLES);
  app.get('/api/v1/users', may('users.manage'), async () => (await users.list()).map(userDto));
  app.post('/api/v1/users', may('users.manage'), async (req, reply) => {
    const body = z
      .object({
        email: z.string().max(254),
        name: z.string().max(120),
        role: Role,
        password: z.string().max(1024),
      })
      .parse(req.body ?? {});
    return reply.status(201).send(userDto(await users.create(body, ctx(req))));
  });
  app.patch('/api/v1/users/:id', may('users.manage'), async (req) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({
        name: z.string().max(120).optional(),
        role: Role.optional(),
        active: z.boolean().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const patch = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    };
    return userDto(await users.update(id, patch, ctx(req)));
  });
  app.post('/api/v1/users/:id/password', may('users.manage'), async (req) => {
    const { id } = Id.parse(req.params);
    const { password } = z.object({ password: z.string().max(1024) }).parse(req.body ?? {});
    await users.setPassword(id, password, ctx(req), 'password.reset');
    return { ok: true };
  });
  app.get('/api/v1/security/events', may('security.audit'), async () =>
    send(
      z.array(ApiSecurityEventSchema),
      (await users.events()).map(({ e, name }) => ({
        id: e.id,
        at: e.createdAt,
        event: e.event,
        userId: e.userId,
        userName: name,
        subjectUserId: e.subjectUserId,
        requestId: e.requestId,
        detail: JSON.parse(e.detailJson) as Record<string, unknown>,
      })),
    ),
  );

  // Deployed instances answer anonymous probes with statuses only (Phase 7C): the environment,
  // ERP and extractor identity, job counts and pool are diagnostics, for an ADMIN
  // (GET /api/v1/system/status). Development keeps the detail on the public probes.
  const detailed = environment === 'development';
  // Which build is live: the commit the platform deployed (not a secret; nothing else).
  const release = options.release ?? null;
  const demoOn = Boolean(options.resetDemo) && environment !== 'production';
  app.get('/api/v1/health', PUBLIC, async () =>
    detailed
      ? {
          ok: true,
          environment,
          demo: demoOn,
          erp: veyra.erp.info,
          extractor: { id: veyra.extractor.id, version: veyra.extractor.version },
          version: release,
        }
      : { ok: true, demo: demoOn, version: release },
  );
  // Liveness: the process is up and serving. No dependency is checked.
  app.get('/api/v1/health/live', PUBLIC, async () => ({ status: 'ok' }));
  // Readiness: this instance can do its work (database, storage, worker). 503 when it cannot.
  app.get('/api/v1/health/ready', PUBLIC, async (_req, reply) => {
    if (!options.readiness) return { status: 'ready', environment };
    const report = await options.readiness();
    return reply
      .status(report.status === 'ready' ? 200 : 503)
      .send(detailed ? report : publicReadiness(report));
  });
  // The full readiness report (job counts, pool, ERP status, worker tick) for an ADMIN.
  app.get('/api/v1/system/status', may('security.audit'), async () => {
    if (!options.readiness) return { status: 'ready', environment };
    return options.readiness();
  });

  // ── Documents ────────────────────────────────────────────────────────────
  app.post('/api/v1/documents', may('documents.upload'), async (req, reply) => {
    const file = await req.file();
    if (!file) throw new VeyraError('INVALID_INPUT', 'Attach the invoice file.');
    const bytes = await file.toBuffer();
    const { result: created, stages } = await timedScope(() =>
      veyra.upload({ filename: file.filename, bytes }, actorOf(req)),
    );
    req.log.info(
      { documentId: created.documentId, invoiceId: created.invoiceId, stages },
      'document stored',
    );
    return reply.status(201).send(created);
  });

  app.get('/api/v1/documents', may('invoices.view'), async () =>
    (
      await veyra.db
        .select()
        .from(t.documents)
        .innerJoin(t.invoices, eq(t.invoices.documentId, t.documents.id))
        .orderBy(desc(t.documents.uploadedAt), desc(t.documents.seq))
    ).map(({ documents: d, invoices: i }) => ({
      id: d.id,
      filename: d.filename,
      mime: d.mime,
      sizeBytes: d.sizeBytes,
      sha256: d.sha256,
      uploadedAt: d.uploadedAt,
      invoiceId: i.id,
      state: i.state,
    })),
  );

  const documentRow = async (id: string) => {
    const d = (await veyra.db.select().from(t.documents).where(eq(t.documents.id, id)).limit(1))[0];
    if (!d) throw new VeyraError('NOT_FOUND', 'Document not found.');
    return d;
  };

  app.get('/api/v1/documents/:id', may('invoices.view'), async (req) => {
    const d = await documentRow(Id.parse(req.params).id);
    const inv = (
      await veyra.db.select().from(t.invoices).where(eq(t.invoices.documentId, d.id)).limit(1)
    )[0];
    return {
      id: d.id,
      filename: d.filename,
      mime: d.mime,
      sizeBytes: d.sizeBytes,
      sha256: d.sha256,
      uploadedAt: d.uploadedAt,
      invoiceId: inv?.id ?? null,
      state: inv?.state ?? null,
      failureReason: inv?.failureReason ?? null,
      // AVAILABLE, or DELETED: the original is gone; the processing record stays.
      status: d.status,
      deletedAt: d.deletedAt ?? null,
      // An available original whose stored copy is missing (lost by storage, not deleted).
      fileMissing: !(await veyra.documentFileExists(d)) && d.status === 'AVAILABLE',
      extraction: inv ? await latestExtraction(inv.id) : null,
    };
  });

  /** How the document was last read: which extractor, how many pages, which read methods. */
  const latestExtraction = async (invoiceId: string) => {
    const x = (
      await veyra.db
        .select()
        .from(t.extractions)
        .where(eq(t.extractions.invoiceId, invoiceId))
        .orderBy(desc(t.extractions.createdAt), desc(t.extractions.seq))
        .limit(1)
    )[0];
    if (!x) return null;
    const raw = JSON.parse(x.rawJson) as {
      pages?: number;
      warnings?: string[];
      otherFields?: { label: string; value: string; evidence: { page: number } | null }[];
    };
    const methods = (
      await veyra.db
        .selectDistinct({ method: t.extractedFields.method })
        .from(t.extractedFields)
        .where(eq(t.extractedFields.extractionId, x.id))
    )
      .map((r) => r.method)
      .filter((m): m is string => m !== null)
      .sort();
    return {
      extractor: x.extractorId,
      version: x.extractorVersion,
      pages: raw.pages ?? null,
      methods,
      warnings: raw.warnings ?? [],
      // Everything else printed on the document, exactly as printed (label, value, page).
      otherFields: (raw.otherFields ?? []).map((f) => ({
        label: f.label,
        value: f.value,
        page: f.evidence?.page ?? null,
      })),
      readAt: x.createdAt,
    };
  };

  // Server-mediated, authorized, audited: never a public URL or a storage path. The file is
  // untrusted: its type was decided by its bytes at upload, it is never executed, and it is
  // served with nosniff, a CSP that allows nothing active, and (images) a sandbox.
  /** The original's bytes; a deleted original is gone (never a broken or substitute file). */
  const availableDocument = async (id: string) => {
    const d = await documentRow(id);
    if (d.status === 'DELETED')
      throw new VeyraError('NOT_FOUND', 'The original invoice document was deleted.');
    return d;
  };

  app.get('/api/v1/documents/:id/file', may('documents.view'), async (req, reply) => {
    const d = await availableDocument(Id.parse(req.params).id);
    const bytes = Buffer.from(await veyra.readDocument(d));
    await users.record('document.accessed', ctx(req), { documentId: d.id });
    const ascii = d.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return reply
      .header('content-type', d.mime)
      .header(
        'content-disposition',
        `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(d.filename)}`,
      )
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header(
        'content-security-policy',
        d.mime === 'application/pdf'
          ? "default-src 'none'; frame-ancestors 'self'"
          : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
      )
      .send(bytes);
  });

  // One page of the ORIGINAL document as an image, to show it as it was uploaded (a PDF page is
  // drawn exactly as a PDF viewer would; a photo is itself). Same access rule as the file.
  app.get('/api/v1/documents/:id/pages/:page', may('documents.view'), async (req, reply) => {
    const { id, page } = z
      .object({ id: z.string().min(1).max(64), page: z.coerce.number().int().min(1).max(500) })
      .parse(req.params);
    const d = await availableDocument(id);
    const bytes = await veyra.readDocument(d);
    if (page === 1) await users.record('document.accessed', ctx(req), { documentId: d.id });
    let body: Uint8Array;
    let mime = d.mime;
    if (d.mime === 'application/pdf') {
      const drawn = await renderPdfPage(bytes, page);
      if (!drawn) throw new VeyraError('NOT_FOUND', 'The document has no such page.');
      body = drawn.png;
      mime = 'image/png';
    } else {
      if (page !== 1) throw new VeyraError('NOT_FOUND', 'The document has no such page.');
      // Shown upright, exactly as it was read (the same check), so evidence boxes line up.
      body =
        d.mime === 'image/png' || d.mime === 'image/jpeg'
          ? (await uprightImage(Buffer.from(bytes), d.mime)).bytes
          : bytes;
    }
    return reply
      .header('content-type', mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=600')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'self'; sandbox")
      .send(Buffer.from(body));
  });

  // ── Invoices ─────────────────────────────────────────────────────────────
  app.get('/api/v1/invoices', may('invoices.view'), async () =>
    send(ApiInboxSchema, await present.inbox()),
  );

  app.get('/api/v1/invoices/:id', may('invoices.view'), async (req) =>
    send(ApiInvoiceDetailSchema, await present.detail(Id.parse(req.params).id)),
  );

  app.post('/api/v1/invoices/:id/reject', may('invoices.reject'), async (req) => {
    const { id } = Id.parse(req.params);
    const { reason } = z
      .object({ reason: z.string().trim().min(1).max(300) })
      .parse(req.body ?? {});
    await veyra.reject(id, reason, actorOf(req));
    return { invoiceId: id, state: (await veyra.invoiceRow(veyra.db, id)).state };
  });

  // Deletes the ORIGINAL document only: the invoice record, its checks and its audit trail stay.
  app.post('/api/v1/documents/:id/delete', may('documents.delete'), async (req) => {
    const d = await documentRow(Id.parse(req.params).id);
    const { reason } = z
      .object({ reason: z.string().trim().max(300).optional() })
      .parse(req.body ?? {});
    const inv = (
      await veyra.db.select().from(t.invoices).where(eq(t.invoices.documentId, d.id)).limit(1)
    )[0];
    if (!inv) throw new VeyraError('NOT_FOUND', 'Document not found.');
    const deleted = await veyra.deleteDocument(inv.id, actorOf(req), reason);
    return { documentId: d.id, status: 'DELETED', deleted };
  });

  // ── Document retention (the customer's choice) ───────────────────────────
  const RetentionBody = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('KEEP') }),
    z.object({ mode: z.literal('DELETE_AFTER_SUCCESS') }),
    z.object({ mode: z.literal('DELETE_AFTER_DAYS'), days: z.number().int() }),
  ]);
  app.get('/api/v1/settings/retention', may('invoices.view'), async () => veyra.retentionPolicy());
  app.put('/api/v1/settings/retention', may('settings.manage'), async (req) => {
    const body = RetentionBody.parse(req.body ?? {});
    return veyra.setRetentionPolicy(
      { mode: body.mode, days: body.mode === 'DELETE_AFTER_DAYS' ? body.days : null },
      actorOf(req),
    );
  });

  app.post('/api/v1/invoices/:id/reprocess', may('invoices.reprocess'), async (req) => {
    const { id } = Id.parse(req.params);
    await veyra.reprocess(id, actorOf(req));
    return { invoiceId: id, state: (await veyra.invoiceRow(veyra.db, id)).state };
  });

  // Whether the invoice reader works right now (a tiny request, no document): for whoever sets
  // Veyrafy up. Plain words first; the technical reason for the administrator.
  app.post('/api/v1/reader/check', may('imports.manage'), async () => {
    if (!options.aiReader)
      return {
        configured: false,
        ok: false,
        ms: 0,
        plain:
          "Veyrafy's main reader isn't switched on, so invoices are read by the simpler reader.",
        technical: 'VEYRA_AI_READER is not set',
      };
    const r = await options.aiReader.test();
    return {
      configured: true,
      ok: r.ok,
      ms: r.ms,
      plain: r.ok
        ? `Veyrafy's main reader is working (it answered in ${(r.ms / 1000).toFixed(1)} seconds)${
            r.skipped.length ? ', using its backup because the first choice was busy' : ''
          }.`
        : readerProblem(r.reason ?? ''),
      technical: [
        ...r.skipped.map((m) => `model ${m}`),
        ...(r.ok ? [`model ${r.model}: answered`] : []),
      ].join('\n'),
    };
  });

  app.post('/api/v1/invoices/:id/recheck', may('invoices.reprocess'), async (req) => {
    const { id } = Id.parse(req.params);
    await veyra.recheckReceipt(id, actorOf(req));
    return { invoiceId: id, state: (await veyra.invoiceRow(veyra.db, id)).state };
  });

  // ── ERP goods-receipt records (the business's own ERP export) ────────────
  app.post(
    '/api/v1/erp/receipt-records',
    { ...may('imports.manage'), bodyLimit: 25 * 1024 * 1024 },
    async (req, reply) => {
      const { filename, content } = z
        .object({ filename: z.string().trim().min(1).max(255), content: z.string().min(2) })
        .parse(req.body ?? {});
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        throw new VeyraError(
          'INVALID_INPUT',
          "This file couldn't be opened as an export from your ERP. Check that you chose the right file.",
        );
      }
      return reply.status(201).send(await veyra.importReceipts(filename, json, actorOf(req)));
    },
  );
  app.get('/api/v1/erp/receipt-records', may('erp.view'), async () => veyra.listReceipts());
  app.post('/api/v1/erp/receipt-records/:id/check', may('documents.upload'), async (req, reply) => {
    const { id } = Id.parse(req.params);
    return reply.status(201).send(await veyra.checkReceiptAttachment(id, actorOf(req)));
  });

  // ── Questions ────────────────────────────────────────────────────────────
  app.get('/api/v1/questions', may('invoices.view'), async (req) => {
    const { status } = z
      .object({ status: z.enum(['open', 'answered']).default('open') })
      .parse(req.query ?? {});
    return send(z.array(ApiQuestionSchema), await present.questions(status));
  });

  app.get('/api/v1/questions/:id', may('invoices.view'), async (req) => {
    const q = await present.question(Id.parse(req.params).id);
    if (!q) throw new VeyraError('NOT_FOUND', 'Question not found.');
    return send(ApiQuestionSchema, q);
  });

  app.post('/api/v1/questions/:id/answer', may('questions.answer'), async (req) => {
    const { id } = Id.parse(req.params);
    const body = ApiAnswerBodySchema.parse(req.body ?? {});
    const { stages } = await timedScope(() =>
      veyra.answer(id, { optionId: body.optionId, input: body.input ?? null }, actorOf(req)),
    );
    req.log.info({ questionId: id, stages }, 'question answered');
    const q = await present.question(id);
    return {
      questionId: id,
      invoiceId: q?.invoiceId ?? null,
      state: q ? (await veyra.invoiceRow(veyra.db, q.invoiceId)).state : null,
    };
  });

  // ── Audit ────────────────────────────────────────────────────────────────
  app.get('/api/v1/audit', may('audit.invoice'), async (req) => {
    const { invoiceId, scope } = z
      .object({
        invoiceId: z
          .string()
          .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
          .optional(),
        scope: z.enum(['records']).optional(),
      })
      .parse(req.query ?? {});
    // One invoice's trail needs audit.invoice (checked for the route); the whole trail more.
    if (scope === 'records' || !invoiceId) requirePermission(req, 'audit.view');
    if (scope === 'records')
      return send(z.array(ApiAuditEntrySchema), await present.recordsAudit());
    return send(z.array(ApiAuditEntrySchema), await present.audit(invoiceId ?? null));
  });

  // ── ERP (read-only, through ErpConnector) ────────────────────────────────
  const erp = veyra.erp;
  const ERP = may('erp.view');
  app.get('/api/v1/erp/company', ERP, async () => erp.getCompany());
  // Read-only (Phase 4): which business system, whether it is connected, what it can do.
  app.get('/api/v1/erp/connection', ERP, async () => {
    const c = await describeConnection(erp);
    return send(ApiErpSchema.connection, {
      type: c.type,
      displayName: c.displayName,
      version: c.version,
      status: c.status,
      company: c.company,
      capabilities: ERP_CAPABILITIES.map((key) => ({
        key,
        label: CAPABILITY_LABEL[key],
        supported: c.capabilities.includes(key),
      })),
    });
  });
  app.get('/api/v1/erp/vendors', ERP, async () =>
    send(
      ApiErpSchema.vendors,
      (await erp.listVendors()).map((v) => ({
        code: v.code,
        name: v.name,
        gstin: v.gstin,
        state: stateName(v.stateCode) ?? v.stateCode,
        status: v.status,
        origin: v.origin,
      })),
    ),
  );
  app.get('/api/v1/erp/items', ERP, async () =>
    send(
      ApiErpSchema.items,
      (await erp.listItems()).map((i) => ({
        code: i.code,
        name: i.name,
        hsnSac: i.hsnSac,
        uom: i.uom,
        gstRateBp: i.gstRateBp,
        origin: i.origin,
      })),
    ),
  );
  app.get('/api/v1/erp/purchase-orders', ERP, async () => {
    const vendors = new Map((await erp.listVendors()).map((v) => [v.id, v.name]));
    const items = new Map((await erp.listItems()).map((i) => [i.id, i]));
    return send(
      ApiErpSchema.purchaseOrders,
      (await erp.listPurchaseOrders()).map((po) => ({
        poNumber: po.poNumber,
        vendor: vendors.get(po.vendorId) ?? po.vendorId,
        poDate: po.poDate,
        lines: po.lines
          .map(
            (l) =>
              `${items.get(l.itemId)?.name ?? l.itemId} × ${formatQty(milliQty(l.qtyMilli))} ${items.get(l.itemId)?.uom ?? ''} @ ${formatInr(paise(l.unitPricePaise))}`,
          )
          .join('; '),
        status: po.status,
        origin: po.origin,
      })),
    );
  });
  app.get('/api/v1/erp/grns', ERP, async () => {
    const pos = await erp.listPurchaseOrders();
    const items = new Map((await erp.listItems()).map((i) => [i.id, i]));
    const poLine = new Map(
      pos.flatMap((p) =>
        p.lines.map((l) => [l.id, { po: p.poNumber, uom: items.get(l.itemId)?.uom ?? '' }]),
      ),
    );
    return send(
      ApiErpSchema.grns,
      (await erp.listGrns()).map((g) => ({
        grnNumber: g.grnNumber,
        poNumber: pos.find((p) => p.id === g.poId)?.poNumber ?? g.poId,
        grnDate: g.grnDate,
        accepted: g.lines
          .map(
            (l) =>
              `${formatQty(milliQty(l.acceptedQtyMilli))} ${poLine.get(l.poLineId)?.uom ?? ''}`,
          )
          .join('; '),
        origin: g.origin,
      })),
    );
  });
  app.get('/api/v1/erp/purchase-invoices', ERP, async () => {
    const vendors = new Map((await erp.listVendors()).map((v) => [v.id, v.name]));
    const orders = new Map((await erp.listPurchaseOrders()).map((o) => [o.id, o.poNumber]));
    return send(
      ApiErpSchema.purchaseInvoices,
      (await erp.listPurchaseInvoices()).map((p) => ({
        id: p.id,
        vendorInvoiceNo: p.vendorInvoiceNo,
        vendor: vendors.get(p.vendorId) ?? p.vendorId,
        invoiceDate: p.invoiceDate,
        totalPaise: p.totalPaise,
        status: p.status,
        poNumber: orders.get(p.poId) ?? null,
        lines: p.lines.length,
      })),
    );
  });

  // ── Business records: templates, import, export (Phase 3C) ──────────────
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const download = (reply: FastifyReply, name: string, type: string, body: Buffer) =>
    reply
      .header('content-type', type)
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('x-content-type-options', 'nosniff')
      .send(body);

  const IMPORTS = may('imports.manage');
  app.get('/api/v1/imports/templates', IMPORTS, async () =>
    templateFiles().map((f) => ({
      ...f,
      url: `/api/v1/imports/templates/${encodeURIComponent(f.file)}`,
    })),
  );
  app.get('/api/v1/imports/templates/:file', IMPORTS, async (req, reply) => {
    const { file } = z.object({ file: z.string().max(80) }).parse(req.params);
    const body = templateWorkbook(file);
    if (!body) throw new VeyraError('NOT_FOUND', 'No such template.');
    return download(reply, file, XLSX, body);
  });

  app.post('/api/v1/imports', IMPORTS, async (req, reply) => {
    const files: { filename: string; bytes: Uint8Array }[] = [];
    for await (const part of req.files())
      files.push({ filename: part.filename, bytes: await part.toBuffer() });
    if (files.length === 0) throw new VeyraError('INVALID_INPUT', 'Attach a file to import.');
    return reply.status(201).send(send(ApiImportSchema, await imports.check(files, actorOf(req))));
  });
  app.get('/api/v1/imports', IMPORTS, async () =>
    send(z.array(ApiImportSchema), await imports.list()),
  );
  app.get('/api/v1/imports/:id', IMPORTS, async (req) =>
    send(ApiImportSchema, await imports.get(Id.parse(req.params).id)),
  );
  app.post('/api/v1/imports/:id/confirm', IMPORTS, async (req) =>
    send(ApiImportSchema, await imports.confirm(Id.parse(req.params).id, actorOf(req))),
  );

  app.get('/api/v1/exports/:name', may('exports.download'), async (req, reply) => {
    await veyra.entitlements.require(veyra.organizationId, 'reports.exports');
    const { name } = z.object({ name: z.string().max(40) }).parse(req.params);
    if (name === 'business-records.xlsx')
      return download(
        reply,
        'Business-records.xlsx',
        XLSX,
        businessRecordsXlsx(await imports.snapshot()),
      );
    const m = /^(invoices|decisions|audit)\.(xlsx|csv)$/.exec(name);
    const kind = m?.[1] as 'invoices' | 'decisions' | 'audit' | undefined;
    if (!kind) throw new VeyraError('NOT_FOUND', 'No such export.');
    const table =
      kind === 'invoices'
        ? await invoicesTable(present)
        : kind === 'decisions'
          ? await decisionsTable(present)
          : await auditTable(present);
    const file = `Veyrafy-${kind}-${veyra.today()}`;
    return m?.[2] === 'csv'
      ? download(reply, `${file}.csv`, 'text/csv; charset=utf-8', tableCsv(table))
      : download(reply, `${file}.xlsx`, XLSX, tableXlsx(table));
  });

  // ── Commercial capabilities, as the customer's users see them (Phase 8A) ──
  // Availability and usage against limits only: never the plan, overrides or reasons. The web app
  // shows or hides features from this; the server enforces them on every route regardless.
  app.get('/api/v1/capabilities', may('invoices.view'), async () => {
    const [all, usage] = await Promise.all([
      veyra.entitlements.all(veyra.organizationId),
      usageOf(veyra.db, veyra.organizationId, veyra.clock()),
    ]);
    return send(ApiCapabilitiesSchema, {
      capabilities: all
        .filter((e) => e.definition.customerVisible)
        .map((e) =>
          'enabled' in e.effective
            ? {
                key: e.capability,
                name: e.definition.name,
                type: 'BOOLEAN' as const,
                available: e.effective.enabled,
              }
            : {
                key: e.capability,
                name: e.definition.name,
                type: 'LIMIT' as const,
                available: e.effective.limit !== 0,
                limit: e.effective.limit,
                used: usedFor(e.capability, usage),
              },
        ),
    });
  });

  // ── The 5 Invoice Challenge (public; the challenge's own token) ─────────
  if (options.challenge)
    registerChallengeRoutes(app, options.challenge, { cookieSecure: options.auth.cookieSecure });

  // ── Veyra Operations (Phase 8A): VEYRA_ADMIN only ────────────────────────
  registerOps(app, {
    ...(options.challenge ? { challenge: options.challenge } : {}),
    veyra,
    commercial:
      options.commercial ?? new CommercialAdmin(veyra.db, veyra.entitlements, veyra.clock),
    users,
    environment,
    ...(options.readiness ? { readiness: options.readiness } : {}),
    send,
    suspensionChanged,
    aiModels: options.aiReader?.models ?? [],
    limits: { maxUploadBytes, rateLimitsPerMinute: rateLimits },
  });

  // ── Dev ──────────────────────────────────────────────────────────────────
  // Never in production, whatever else is configured (enforced here, not by the UI). Staging may
  // run with NODE_ENV=production; the Veyra environment decides.
  if (options.resetDemo && environment !== 'production') {
    const reset = options.resetDemo;
    const DEMO = may('demo.manage');
    app.post('/api/v1/dev/reset', DEMO, async (req) => {
      const { erp: mode } = z
        .object({ erp: z.enum(['demo', 'empty']).default('demo') })
        .parse(req.body ?? {});
      await reset(mode);
      return { ok: true, erp: mode };
    });
    // Demo scenarios (Phase 3E): each uploads one synthetic invoice through the normal path.
    app.get('/api/v1/dev/scenarios', DEMO, async () =>
      send(
        z.array(ApiDemoScenarioSchema),
        DEMO_SCENARIOS.map(({ key, title, story, expect }) => ({ key, title, story, expect })),
      ),
    );
    app.post('/api/v1/dev/scenarios/:key', DEMO, async (req, reply) => {
      const { key } = z.object({ key: z.string() }).parse(req.params);
      const started = await startScenario(veyra, key, options.demoBusiness ?? 'manufacturing');
      if (!started) throw new VeyraError('NOT_FOUND', 'There is no such demo scenario.');
      return reply.status(started.existing ? 200 : 201).send(started);
    });
  }

  // The web app on this same origin (production client instances): every non-/api GET.
  // A client or demo instance is never indexed (only the public website is).
  if (options.web) registerWebApp(app, options.web, { indexable: false });

  return app;
}

/** What a failed reader test means, in plain words. */
function readerProblem(reason: string): string {
  if (/not found|refused|rejected/.test(reason))
    return "Veyrafy's main reader isn't set up correctly. Check the reader settings with whoever set up Veyrafy.";
  if (/quota|rate limit/.test(reason))
    return "Veyrafy's main reader has reached its usage limit for now. Try again later, or raise the limit.";
  if (/in time|could not be reached/.test(reason))
    return "Veyrafy's main reader couldn't be reached just now. Try again in a minute.";
  return "Veyrafy's main reader is busy just now. Try again in a minute.";
}
