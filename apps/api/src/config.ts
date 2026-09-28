import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '@veyra/shared';
import { DOCUMENT_LIMITS } from '@veyra/extractor';

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

export interface StorageConfig {
  kind: 'local' | 's3';
  /** local: the folder for stored documents. */
  dir: string;
  /** s3: an S3-compatible bucket (AWS S3, DigitalOcean Spaces, MinIO, …). */
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    prefix: string;
  } | null;
}

export interface VeyraConfig {
  environment: Environment;
  host: string;
  port: number;
  dataDir: string;
  /** Apply pending database migrations at startup (off in production: run `db:migrate`). */
  migrateOnStart: boolean;
  storage: StorageConfig;
  /** Only the fake ERP exists so far; production must name it explicitly. */
  erp: 'fake';
  demo: boolean;
  allowFixtureExtractor: boolean;
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
  rateLimits: { uploadsPerMinute: number; processingPerMinute: number; devPerMinute: number };
  jobs: { leaseMs: number; shutdownGraceMs: number };
}

type Env = Readonly<Record<string, string | undefined>>;

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** Every variable Veyra reads, with its rule. Secrets are marked so they are never echoed. */
const VARS = {
  VEYRA_ENV: z.enum(ENVIRONMENTS),
  VEYRA_API_HOST: z.string().min(1).max(255),
  VEYRA_API_PORT: int(1, 65_535),
  VEYRA_DATA_DIR: z.string().min(1),
  VEYRA_MIGRATE_ON_START: bool,
  VEYRA_STORAGE: z.enum(['local', 's3']),
  VEYRA_STORAGE_DIR: z.string().min(1),
  VEYRA_S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  VEYRA_S3_REGION: z.string().regex(/^[a-z0-9-]{2,32}$/),
  VEYRA_S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  VEYRA_S3_ACCESS_KEY_ID: z.string().min(1).max(256),
  VEYRA_S3_SECRET_ACCESS_KEY: z.string().min(1).max(256),
  VEYRA_S3_FORCE_PATH_STYLE: bool,
  VEYRA_S3_PREFIX: z.string().regex(/^([a-z0-9][a-z0-9._-]*\/)*$/),
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
  VEYRA_JOB_LEASE_MS: int(10_000, 24 * 60 * 60 * 1000),
  VEYRA_SHUTDOWN_GRACE_MS: int(0, 10 * 60 * 1000),
} as const;
type VarName = keyof typeof VARS;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Veyra configuration is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Reads and validates the configuration. Throws ConfigError listing every problem (variable names
 * and rules only; values are never included, since some are secrets).
 */
export function loadConfig(env: Env, defaults: { dataDir: string }): VeyraConfig {
  const problems: string[] = [];
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
  const deployed = environment !== 'development';
  if (environment === 'production' && env.NODE_ENV !== 'production')
    problems.push('NODE_ENV must be production when VEYRA_ENV is production');

  const dataDirRaw = deployed
    ? require('VEYRA_DATA_DIR', `in ${environment}`)
    : (read('VEYRA_DATA_DIR') ?? defaults.dataDir);
  if (dataDirRaw !== undefined && deployed && !isAbsolute(dataDirRaw))
    problems.push('VEYRA_DATA_DIR must be an absolute path outside development');
  const dataDir = resolve(dataDirRaw ?? defaults.dataDir);

  const storageKind = deployed
    ? require('VEYRA_STORAGE', `in ${environment} (local or s3)`)
    : (read('VEYRA_STORAGE') ?? 'local');
  let s3: StorageConfig['s3'] = null;
  if (storageKind === 's3') {
    const endpoint = require('VEYRA_S3_ENDPOINT', 'when VEYRA_STORAGE=s3');
    const region = require('VEYRA_S3_REGION', 'when VEYRA_STORAGE=s3');
    const bucket = require('VEYRA_S3_BUCKET', 'when VEYRA_STORAGE=s3');
    const accessKeyId = require('VEYRA_S3_ACCESS_KEY_ID', 'when VEYRA_STORAGE=s3');
    const secretAccessKey = require('VEYRA_S3_SECRET_ACCESS_KEY', 'when VEYRA_STORAGE=s3');
    if (endpoint && region && bucket && accessKeyId && secretAccessKey) {
      if (environment === 'production' && !endpoint.startsWith('https://'))
        problems.push('VEYRA_S3_ENDPOINT must use https in production');
      s3 = {
        endpoint: endpoint.replace(/\/+$/, ''),
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: read('VEYRA_S3_FORCE_PATH_STYLE') ?? false,
        prefix: read('VEYRA_S3_PREFIX') ?? '',
      };
    }
  }

  const erp = deployed ? require('VEYRA_ERP', `in ${environment}`) : (read('VEYRA_ERP') ?? 'fake');
  const demo = read('VEYRA_DEMO') ?? !deployed;
  const allowFixtureExtractor = read('VEYRA_ALLOW_FIXTURE_EXTRACTOR') ?? false;
  if (environment === 'production') {
    if (demo) problems.push('VEYRA_DEMO must not be true in production');
    if (allowFixtureExtractor)
      problems.push('VEYRA_ALLOW_FIXTURE_EXTRACTOR must not be true in production');
  }

  const ollamaUrl = read('VEYRA_OLLAMA_URL');
  const migrateOnStart = read('VEYRA_MIGRATE_ON_START') ?? environment !== 'production';

  const config: VeyraConfig = {
    environment,
    host: read('VEYRA_API_HOST') ?? '127.0.0.1',
    port: read('VEYRA_API_PORT') ?? 8787,
    dataDir,
    migrateOnStart,
    storage: {
      kind: storageKind ?? 'local',
      dir: resolve(read('VEYRA_STORAGE_DIR') ?? resolve(dataDir, 'uploads')),
      s3,
    },
    erp: erp ?? 'fake',
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
    },
    jobs: {
      leaseMs: read('VEYRA_JOB_LEASE_MS') ?? 15 * 60 * 1000,
      shutdownGraceMs: read('VEYRA_SHUTDOWN_GRACE_MS') ?? 25_000,
    },
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** What a variable must look like, for the startup error (never its value). */
function describe(name: VarName): string {
  const schema = VARS[name] as z.ZodType;
  if (schema instanceof z.ZodEnum) return `one of ${schema.options.join(', ')}`;
  if (name.endsWith('_ENDPOINT') || name.endsWith('_URL')) return 'an http(s) URL';
  if (/_(PORT|BYTES|PAGES|SIDE|PIXELS|MINUTE|MS|PROXY)$/.test(name))
    return 'a whole number in range';
  if (name === 'VEYRA_S3_PREFIX') return 'lowercase path segments ending in /';
  return 'see .env.example';
}

/** A summary safe to log and show in diagnostics: no secrets, no paths, no endpoints. */
export function describeConfig(c: VeyraConfig) {
  return {
    environment: c.environment,
    storage: c.storage.kind,
    erp: c.erp,
    demo: c.demo,
    migrateOnStart: c.migrateOnStart,
  };
}
