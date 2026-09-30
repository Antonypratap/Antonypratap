import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '@veyra/shared';
import { DOCUMENT_LIMITS } from '@veyra/extractor';
import { Secret } from './secret';

/**
 * Deployment configuration (Phase 6). Everything environment-specific comes from environment
 * variables, validated once at startup. A deployment that is missing or misstates something does
 * not start: `loadConfig` returns the problems by variable NAME, never with their values.
 *
 * Environments: `development` (local, demo on by default), `staging` (a production-like copy with
 * its own data, storage and ERP), `production` (no demo, no dev endpoints, no fixtures).
 */
export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * Where uploaded documents are kept. Only local storage exists today (a folder, which must be a
 * persistent disk when deployed); object storage is a future adapter behind DocumentStorage.
 */
export interface StorageConfig {
  kind: 'local';
  dir: string;
}

/**
 * The ERP connector's own configuration (Phase 6C): the ONLY object that will ever carry ERP
 * credentials. It is built here, handed to the composition root's connector factory and nowhere
 * else (not the workflow, the HTTP layer, the audit trail or the browser). The fake ERP needs no
 * credentials; a real connector adds its fields here as `Secret`s.
 */
export interface ErpConnectorConfig {
  kind: 'fake';
}

export interface VeyraConfig {
  environment: Environment;
  /** The one organization this deployment serves (Phase 6C). */
  organizationName: string;
  host: string;
  port: number;
  dataDir: string;
  /**
   * The Veyra application database: PostgreSQL. `url` is required in staging and production;
   * in development it may be null (the embedded engine in `<dataDir>/pgdata` is used).
   */
  database: {
    /** A secret (it usually holds the password): `reveal()` only where the pool is opened. */
    url: Secret | null;
    /**
     * Optional separate credential for `db:migrate` (a role that may change the schema), so the
     * running API can use a role that cannot. Falls back to `url`.
     */
    migrationUrl: Secret | null;
    pool: { max: number; connectTimeoutMs: number; statementTimeoutMs: number };
  };
  /** Apply pending database migrations at startup (off in production: run `db:migrate`). */
  migrateOnStart: boolean;
  storage: StorageConfig;
  /** Only the fake ERP exists so far; production must name it explicitly. */
  erp: ErpConnectorConfig;
  /** Sign-in and sessions (Phase 6C). */
  auth: {
    session: { idleMs: number; absoluteMs: number };
    /** Session cookie only over HTTPS. Always true in production. */
    cookieSecure: boolean;
    /** Demo only (never production): the PIN that opens a demo session. */
    demoPin: Secret | null;
  };
  /**
   * Browser origins (Phase 6C). `publicOrigins`: where users open Veyra (state-changing requests
   * from any other origin are refused). `corsOrigins`: other origins allowed to call the API with
   * credentials (empty: no CORS at all, the normal same-origin deployment). Never "*".
   */
  http: { publicOrigins: string[]; corsOrigins: string[] };
  demo: boolean;
  allowFixtureExtractor: boolean;
  /** Local AI assist. Loopback or private network only, unless explicitly allowed. */
  ollama: { baseUrl: string; model: string } | null;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'silent';
  /** Proxy hops to trust for the client address (rate limiting). 0 = none. */
  trustProxy: number;
  limits: {
    maxUploadBytes: number;
    maxJsonBodyBytes: number;
    maxPdfPages: number;
    maxImageSide: number;
    maxImagePixels: number;
  };
  rateLimits: {
    uploadsPerMinute: number;
    processingPerMinute: number;
    devPerMinute: number;
    loginPerMinute: number;
  };
  jobs: { leaseMs: number; shutdownGraceMs: number };
  /** The built web app served from this origin (production client instances), or null. */
  web: { dist: string | null };
  /** The deployed commit (RAILWAY_GIT_COMMIT_SHA), for GET /api/v1/health; null when unknown. */
  release: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const postgresUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'postgres:' || u.protocol === 'postgresql:') && u.hostname !== '';
    } catch {
      return false;
    }
  });
/** A comma-separated list of exact origins (scheme://host[:port]); never "*" or a path. */
const origins = z
  .string()
  .max(2000)
  .transform((v) => v.split(',').map((o) => o.trim()))
  .refine((list) =>
    list.every((o) => {
      try {
        const u = new URL(o);
        return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o;
      } catch {
        return false;
      }
    }),
  );

/** Every variable Veyra reads, with its rule. Secrets are marked so they are never echoed. */
const VARS = {
  VEYRA_ENV: z.enum(ENVIRONMENTS),
  VEYRA_API_HOST: z.string().min(1).max(255),
  VEYRA_API_PORT: int(1, 65_535),
  // The port most hosting platforms assign (Render, Railway, Fly, Heroku-style); VEYRA_API_PORT wins.
  PORT: int(1, 65_535),
  VEYRA_DATA_DIR: z.string().min(1),
  // Never echoed: it usually contains the database password.
  DATABASE_URL: postgresUrl,
  DATABASE_MIGRATION_URL: postgresUrl,
  VEYRA_DB_REQUIRE_TLS: bool,
  VEYRA_ORGANIZATION_NAME: z.string().trim().min(1).max(120),
  VEYRA_PUBLIC_ORIGIN: origins,
  VEYRA_CORS_ORIGINS: origins,
  VEYRA_COOKIE_SECURE: bool,
  VEYRA_SESSION_IDLE_MINUTES: int(5, 24 * 60),
  VEYRA_SESSION_ABSOLUTE_HOURS: int(1, 24 * 30),
  // Never echoed.
  VEYRA_DEMO_PIN: z.string().regex(/^\d{4,12}$/),
  VEYRA_OLLAMA_ALLOW_REMOTE: bool,
  VEYRA_DB_POOL_MAX: int(1, 200),
  VEYRA_DB_CONNECT_TIMEOUT_MS: int(100, 120_000),
  VEYRA_DB_STATEMENT_TIMEOUT_MS: int(100, 3_600_000),
  VEYRA_MIGRATE_ON_START: bool,
  VEYRA_STORAGE_DIR: z.string().min(1),
  VEYRA_ERP: z.enum(['fake']),
  VEYRA_DEMO: bool,
  VEYRA_ALLOW_FIXTURE_EXTRACTOR: bool,
  VEYRA_OLLAMA_URL: z.url({ protocol: /^https?$/ }),
  VEYRA_OLLAMA_MODEL: z.string().min(1).max(100),
  VEYRA_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']),
  VEYRA_TRUST_PROXY: int(0, 10),
  VEYRA_MAX_UPLOAD_BYTES: int(1024, MAX_UPLOAD_BYTES),
  VEYRA_MAX_JSON_BODY_BYTES: int(1024, 10 * 1024 * 1024),
  VEYRA_MAX_PDF_PAGES: int(1, DOCUMENT_LIMITS.maxPdfPages),
  VEYRA_MAX_IMAGE_SIDE: int(100, DOCUMENT_LIMITS.maxImageSide),
  VEYRA_MAX_IMAGE_PIXELS: int(10_000, DOCUMENT_LIMITS.maxImagePixels),
  VEYRA_RATE_LIMIT_UPLOADS_PER_MINUTE: int(1, 10_000),
  VEYRA_RATE_LIMIT_PROCESSING_PER_MINUTE: int(1, 10_000),
  VEYRA_RATE_LIMIT_DEV_PER_MINUTE: int(1, 10_000),
  VEYRA_RATE_LIMIT_LOGIN_PER_MINUTE: int(1, 1_000),
  VEYRA_JOB_LEASE_MS: int(10_000, 24 * 60 * 60 * 1000),
  VEYRA_SHUTDOWN_GRACE_MS: int(0, 10 * 60 * 1000),
  // The built web app (apps/web/dist) this instance serves on its own origin; absent: /api only.
  VEYRA_WEB_DIST: z.string().min(1),
  // true: this process is the public website only (site.ts); read by main.ts before anything else.
  VEYRA_SITE_ONLY: bool,
} as const;
type VarName = keyof typeof VARS;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Veyrafy configuration is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Reads and validates the configuration. Throws ConfigError listing every problem (variable names
 * and rules only; values are never included, since some are secrets).
 */
/** Reads variables by their rules, collecting problems (names and rules only, never values). */
function reader(env: Env, problems: string[]) {
  const read = <K extends VarName>(name: K): z.output<(typeof VARS)[K]> | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const parsed = VARS[name].safeParse(raw);
    if (!parsed.success) {
      problems.push(`${name} is not valid (${describe(name)})`);
      return undefined;
    }
    return parsed.data as z.output<(typeof VARS)[K]>;
  };
  const require = <K extends VarName>(name: K, why: string) => {
    const value = read(name);
    if (value === undefined && !problems.some((p) => p.startsWith(`${name} `)))
      problems.push(`${name} is required ${why}`);
    return value;
  };
  // The environment: VEYRA_ENV, or production whenever NODE_ENV says production (never the
  // reverse: an unset VEYRA_ENV on a production host must not open the demo).
  const environment: Environment =
    read('VEYRA_ENV') ?? (env.NODE_ENV === 'production' ? 'production' : 'development');
  if (environment === 'production' && env.NODE_ENV !== 'production')
    problems.push('NODE_ENV must be production when VEYRA_ENV is production');
  return { read, require, environment, deployed: environment !== 'development' };
}

/** The web build directory: absolute outside development (it is a path inside the image). */
function webDist(
  read: ReturnType<typeof reader>['read'],
  deployed: boolean,
  problems: string[],
): string | null {
  const raw = read('VEYRA_WEB_DIST');
  if (raw === undefined) return null;
  if (deployed && !isAbsolute(raw))
    problems.push('VEYRA_WEB_DIST must be an absolute path outside development');
  return resolve(raw);
}

/**
 * The deployed commit, from the platform (Railway sets RAILWAY_GIT_COMMIT_SHA). Only a plain
 * commit hash is ever shown; anything else is treated as unknown, never echoed.
 */
function releaseOf(env: Env): string | null {
  const sha = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null;
}

export function loadConfig(env: Env, defaults: { dataDir: string }): VeyraConfig {
  const problems: string[] = [];
  const { read, require, environment, deployed } = reader(env, problems);
  if (read('VEYRA_SITE_ONLY'))
    problems.push(
      'VEYRA_SITE_ONLY is true: this service is the public website, which never starts the application (see docs/RUNBOOK-RAILWAY.md)',
    );

  const dataDirRaw = deployed
    ? require('VEYRA_DATA_DIR', `in ${environment}`)
    : (read('VEYRA_DATA_DIR') ?? defaults.dataDir);
  if (dataDirRaw !== undefined && deployed && !isAbsolute(dataDirRaw))
    problems.push('VEYRA_DATA_DIR must be an absolute path outside development');
  const dataDir = resolve(dataDirRaw ?? defaults.dataDir);

  const storageDirRaw = read('VEYRA_STORAGE_DIR');
  if (storageDirRaw !== undefined && deployed && !isAbsolute(storageDirRaw))
    problems.push('VEYRA_STORAGE_DIR must be an absolute path outside development');

  const erp = deployed ? require('VEYRA_ERP', `in ${environment}`) : (read('VEYRA_ERP') ?? 'fake');
  const demo = read('VEYRA_DEMO') ?? !deployed;
  const allowFixtureExtractor = read('VEYRA_ALLOW_FIXTURE_EXTRACTOR') ?? false;
  if (environment === 'production') {
    if (demo) problems.push('VEYRA_DEMO must not be true in production');
    if (allowFixtureExtractor)
      problems.push('VEYRA_ALLOW_FIXTURE_EXTRACTOR must not be true in production');
  }

  const ollamaUrl = read('VEYRA_OLLAMA_URL');
  // AI and document data stay on this machine or network unless an operator decides otherwise.
  if (ollamaUrl && !isLocalHost(new URL(ollamaUrl).hostname) && !read('VEYRA_OLLAMA_ALLOW_REMOTE'))
    problems.push(
      'VEYRA_OLLAMA_URL must be on this machine or a private network (set VEYRA_OLLAMA_ALLOW_REMOTE=true to send documents elsewhere)',
    );
  const migrateOnStart = read('VEYRA_MIGRATE_ON_START') ?? environment !== 'production';
  const databaseUrl = deployed
    ? require('DATABASE_URL', `in ${environment} (the PostgreSQL database)`)
    : read('DATABASE_URL');
  const migrationUrl = read('DATABASE_MIGRATION_URL');
  // Remote PostgreSQL in production must use TLS (sslmode in the URL), unless explicitly waived.
  if (environment === 'production' && (read('VEYRA_DB_REQUIRE_TLS') ?? true))
    for (const [name, url] of [
      ['DATABASE_URL', databaseUrl],
      ['DATABASE_MIGRATION_URL', migrationUrl],
    ] as const)
      if (url && !tlsOrLocal(url))
        problems.push(
          `${name} must set sslmode=verify-full (or require) for a database on another host in production`,
        );

  // Sign-in and browser origins (Phase 6C).
  const organizationName = deployed
    ? require('VEYRA_ORGANIZATION_NAME', `in ${environment}`)
    : read('VEYRA_ORGANIZATION_NAME');
  const publicOrigins = deployed
    ? require('VEYRA_PUBLIC_ORIGIN', `in ${environment} (the https:// address users open)`)
    : (read('VEYRA_PUBLIC_ORIGIN') ?? DEV_ORIGINS);
  const corsOrigins = read('VEYRA_CORS_ORIGINS') ?? [];
  const cookieSecure = read('VEYRA_COOKIE_SECURE') ?? deployed;
  if (environment === 'production') {
    if (!cookieSecure) problems.push('VEYRA_COOKIE_SECURE must not be false in production');
    if ([...(publicOrigins ?? []), ...corsOrigins].some((o) => !o.startsWith('https://')))
      problems.push('VEYRA_PUBLIC_ORIGIN and VEYRA_CORS_ORIGINS must be https:// in production');
  }
  const idleMinutes = read('VEYRA_SESSION_IDLE_MINUTES') ?? 30;
  const absoluteHours = read('VEYRA_SESSION_ABSOLUTE_HOURS') ?? 12;
  if (idleMinutes > absoluteHours * 60)
    problems.push(
      'VEYRA_SESSION_IDLE_MINUTES must not be longer than VEYRA_SESSION_ABSOLUTE_HOURS',
    );
  const demoPin = read('VEYRA_DEMO_PIN');
  const demoOn = demo && environment !== 'production';
  if (demoOn && deployed && !demoPin)
    problems.push(`VEYRA_DEMO_PIN is required when VEYRA_DEMO is true in ${environment}`);

  const config: VeyraConfig = {
    environment,
    organizationName: organizationName ?? 'Toit',
    host: read('VEYRA_API_HOST') ?? '127.0.0.1',
    port: read('VEYRA_API_PORT') ?? read('PORT') ?? 8787,
    dataDir,
    database: {
      url: databaseUrl ? new Secret(databaseUrl) : null,
      migrationUrl: migrationUrl ? new Secret(migrationUrl) : null,
      pool: {
        max: read('VEYRA_DB_POOL_MAX') ?? 10,
        connectTimeoutMs: read('VEYRA_DB_CONNECT_TIMEOUT_MS') ?? 5_000,
        statementTimeoutMs: read('VEYRA_DB_STATEMENT_TIMEOUT_MS') ?? 30_000,
      },
    },
    migrateOnStart,
    storage: { kind: 'local', dir: resolve(storageDirRaw ?? resolve(dataDir, 'uploads')) },
    erp: { kind: erp ?? 'fake' },
    auth: {
      session: { idleMs: idleMinutes * 60_000, absoluteMs: absoluteHours * 3_600_000 },
      cookieSecure,
      // The development default is the published demo PIN; any deployed demo sets its own.
      demoPin: demoOn ? new Secret(demoPin ?? '8824') : null,
    },
    http: { publicOrigins: publicOrigins ?? [], corsOrigins },
    demo,
    allowFixtureExtractor,
    ollama: ollamaUrl
      ? { baseUrl: ollamaUrl, model: read('VEYRA_OLLAMA_MODEL') ?? 'llama3.1' }
      : null,
    logLevel: read('VEYRA_LOG_LEVEL') ?? (deployed ? 'info' : 'warn'),
    trustProxy: read('VEYRA_TRUST_PROXY') ?? 0,
    limits: {
      maxUploadBytes: read('VEYRA_MAX_UPLOAD_BYTES') ?? MAX_UPLOAD_BYTES,
      maxJsonBodyBytes: read('VEYRA_MAX_JSON_BODY_BYTES') ?? 1024 * 1024,
      maxPdfPages: read('VEYRA_MAX_PDF_PAGES') ?? DOCUMENT_LIMITS.maxPdfPages,
      maxImageSide: read('VEYRA_MAX_IMAGE_SIDE') ?? DOCUMENT_LIMITS.maxImageSide,
      maxImagePixels: read('VEYRA_MAX_IMAGE_PIXELS') ?? DOCUMENT_LIMITS.maxImagePixels,
    },
    rateLimits: {
      uploadsPerMinute: read('VEYRA_RATE_LIMIT_UPLOADS_PER_MINUTE') ?? 60,
      processingPerMinute: read('VEYRA_RATE_LIMIT_PROCESSING_PER_MINUTE') ?? 120,
      devPerMinute: read('VEYRA_RATE_LIMIT_DEV_PER_MINUTE') ?? 60,
      loginPerMinute: read('VEYRA_RATE_LIMIT_LOGIN_PER_MINUTE') ?? 10,
    },
    jobs: {
      leaseMs: read('VEYRA_JOB_LEASE_MS') ?? 5 * 60 * 1000,
      shutdownGraceMs: read('VEYRA_SHUTDOWN_GRACE_MS') ?? 25_000,
    },
    web: { dist: webDist(read, deployed, problems) },
    release: releaseOf(env),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** The public website process (VEYRA_SITE_ONLY=true): static files and headers, nothing else. */
export interface SiteConfig {
  environment: Environment;
  host: string;
  port: number;
  /** The built web app to serve. Required: the website is nothing but that build. */
  webDist: string;
  /** HSTS (the site is served over HTTPS whenever deployed). */
  hsts: boolean;
  trustProxy: number;
  logLevel: VeyraConfig['logLevel'];
  release: string | null;
}

/**
 * Configuration for the website process. It reads ONLY what a static website needs: no database,
 * storage, ERP, sign-in or job settings are read or required (DATABASE_URL may be absent).
 */
export function loadSiteConfig(env: Env): SiteConfig {
  const problems: string[] = [];
  const { read, require, environment, deployed } = reader(env, problems);
  require('VEYRA_WEB_DIST', '(the built web app the website serves)');
  const dist = webDist(read, deployed, problems);
  const config: SiteConfig = {
    environment,
    host: read('VEYRA_API_HOST') ?? '127.0.0.1',
    port: read('VEYRA_API_PORT') ?? read('PORT') ?? 8787,
    webDist: dist ?? '',
    hsts: deployed,
    trustProxy: read('VEYRA_TRUST_PROXY') ?? 0,
    logLevel: read('VEYRA_LOG_LEVEL') ?? (deployed ? 'info' : 'warn'),
    release: releaseOf(env),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** What a variable must look like, for the startup error (never its value). */
function describe(name: VarName): string {
  const schema = VARS[name] as z.ZodType;
  if (schema instanceof z.ZodEnum) return `one of ${schema.options.join(', ')}`;
  if (name === 'DATABASE_URL' || name === 'DATABASE_MIGRATION_URL')
    return 'a postgres:// or postgresql:// URL';
  if (name.endsWith('_ORIGIN') || name.endsWith('_ORIGINS'))
    return 'comma-separated origins such as https://veyra.example.com, never *';
  if (name === 'VEYRA_DEMO_PIN') return '4 to 12 digits';
  if (name.endsWith('_URL')) return 'an http(s) URL';
  if (/(^|_)(PORT|BYTES|PAGES|SIDE|PIXELS|MINUTE|MINUTES|HOURS|MS|PROXY)$/.test(name))
    return 'a whole number in range';
  return 'see .env.example';
}

/** A summary safe to log and show in diagnostics: no secrets, no paths, no URLs. */
export function describeConfig(c: VeyraConfig) {
  return {
    environment: c.environment,
    database: c.database.url ? 'postgres' : 'embedded-postgres',
    storage: c.storage.kind,
    erp: c.erp.kind,
    cookieSecure: c.auth.cookieSecure,
    cors: c.http.corsOrigins.length > 0,
    demo: c.demo,
    migrateOnStart: c.migrateOnStart,
  };
}

/** The Vite dev server and preview, on both loopback names. */
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

/** Loopback, private (RFC 1918 / unique-local) or a single-label/.local/.internal host name. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // Docker/compose service names and internal DNS; anything with a public-looking name is remote.
  return !h.includes('.') || h.endsWith('.local') || h.endsWith('.internal');
}

/** The URL asks for TLS, or the database is on this machine (loopback or a Unix socket). */
function tlsOrLocal(url: string): boolean {
  const u = new URL(url);
  const mode = u.searchParams.get('sslmode');
  if (mode === 'require' || mode === 'verify-ca' || mode === 'verify-full') return true;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('%2F')
  );
}
