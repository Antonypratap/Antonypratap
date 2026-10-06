import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from './config';

const defaults = { dataDir: '/tmp/veyra-dev' };
const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env, defaults);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a configuration error');
};

const PRODUCTION = {
  NODE_ENV: 'production',
  VEYRA_ENV: 'production',
  VEYRA_DATA_DIR: '/srv/veyra/data',
  VEYRA_ERP: 'fake',
  VEYRA_OLLAMA_URL: 'http://ollama.internal:11434',
  DATABASE_URL: 'postgres://veyra:s3cret-db-pass@db.example.com:5432/veyra?sslmode=verify-full',
  VEYRA_ORGANIZATION_NAME: 'Toit',
  VEYRA_PUBLIC_ORIGIN: 'https://veyra.toit.example',
};
const STAGING = {
  NODE_ENV: 'production',
  VEYRA_ENV: 'staging',
  VEYRA_DATA_DIR: '/srv/veyra-staging',
  VEYRA_ERP: 'fake',
  DATABASE_URL: 'postgresql://veyra@db-staging.internal/veyra_staging',
  VEYRA_ORGANIZATION_NAME: 'Toit (staging)',
  VEYRA_PUBLIC_ORIGIN: 'https://veyra-staging.toit.example',
};

describe('configuration (Phase 6)', () => {
  it('development works with no configuration at all: demo on, local storage, migrations on', () => {
    const c = loadConfig({}, defaults);
    expect(c).toMatchObject({
      environment: 'development',
      demo: true,
      migrateOnStart: true,
      host: '127.0.0.1',
      port: 8787,
      storage: { kind: 'local', dir: '/tmp/veyra-dev/uploads' },
      erp: { kind: 'fake' },
      organizationName: 'Toit',
    });
  });

  it('a complete production configuration is accepted: no demo, no fixtures, no auto-migration', () => {
    const c = loadConfig(PRODUCTION, defaults);
    expect(c).toMatchObject({
      environment: 'production',
      demo: false,
      allowFixtureExtractor: false,
      migrateOnStart: false,
      logLevel: 'info',
      storage: { kind: 'local', dir: '/srv/veyra/data/uploads' },
    });
    expect(c.database.url?.reveal()).toBe(PRODUCTION.DATABASE_URL);
    expect(c.database.pool).toEqual({ max: 10, connectTimeoutMs: 5000, statementTimeoutMs: 30000 });
    expect(JSON.stringify(describeConfig(c))).not.toMatch(/ollama|srv|internal|s3cret|postgres:/);
  });

  it('NODE_ENV=production without VEYRA_ENV is production, never development', () => {
    const e = problems({ NODE_ENV: 'production' });
    expect(e.problems).toEqual(
      expect.arrayContaining([
        'VEYRA_DATA_DIR is required in production',
        'VEYRA_ERP is required in production',
        'DATABASE_URL is required in production (the PostgreSQL database)',
      ]),
    );
  });

  it('DATABASE_URL: required when deployed, validated, never echoed; optional in development', () => {
    const e = problems({ ...PRODUCTION, DATABASE_URL: 'mysql://root:hunter2@db/veyra' });
    expect(e.problems).toEqual(['DATABASE_URL is not valid (a postgres:// or postgresql:// URL)']);
    expect(e.message).not.toMatch(/hunter2|mysql|root/);
    const staging = problems({ ...STAGING, DATABASE_URL: '' });
    expect(staging.problems).toEqual([
      'DATABASE_URL is required in staging (the PostgreSQL database)',
    ]);
    expect(loadConfig({}, defaults).database.url).toBeNull(); // development: embedded PostgreSQL
    expect(loadConfig({ ...PRODUCTION, VEYRA_DB_POOL_MAX: '25' }, defaults).database.pool.max).toBe(
      25,
    );
  });

  it('refuses the demo and the fixture extractor in production', () => {
    const e = problems({
      ...PRODUCTION,
      VEYRA_DEMO: 'true',
      VEYRA_ALLOW_FIXTURE_EXTRACTOR: 'true',
    });
    expect(e.problems).toEqual([
      'VEYRA_DEMO must not be true in production',
      'VEYRA_ALLOW_FIXTURE_EXTRACTOR must not be true in production',
    ]);
  });

  it('deployed paths must be absolute (a relative path would depend on the working directory)', () => {
    expect(problems({ ...PRODUCTION, VEYRA_STORAGE_DIR: 'uploads' }).problems).toEqual([
      'VEYRA_STORAGE_DIR must be an absolute path outside development',
    ]);
  });

  it('invalid values are reported by name and rule, never with the value (secrets stay secret)', () => {
    const e = problems({
      ...PRODUCTION,
      VEYRA_API_PORT: '99999',
      VEYRA_ENV: 'prod',
      VEYRA_OLLAMA_URL: 'ftp://user:hunter2@host',
      VEYRA_MAX_UPLOAD_BYTES: String(500 * 1024 * 1024),
      VEYRA_LOG_LEVEL: 'verbose',
    });
    expect(e.problems).toEqual(
      expect.arrayContaining([
        'VEYRA_API_PORT is not valid (a whole number in range)',
        'VEYRA_ENV is not valid (one of development, staging, production)',
        'VEYRA_OLLAMA_URL is not valid (an http(s) URL)',
        'VEYRA_MAX_UPLOAD_BYTES is not valid (a whole number in range)',
        'VEYRA_LOG_LEVEL is not valid (one of fatal, error, warn, info, debug, silent)',
      ]),
    );
    expect(e.message).not.toMatch(/99999|hunter2|verbose|ftp:/);
  });

  it('VEYRA_ENV=production requires NODE_ENV=production', () => {
    expect(problems({ ...PRODUCTION, NODE_ENV: 'development' }).problems).toContain(
      'NODE_ENV must be production when VEYRA_ENV is production',
    );
  });

  it('staging is production-like but may run the demo, with its own data dir and storage', () => {
    const c = loadConfig({ ...STAGING, VEYRA_DEMO: 'true', VEYRA_DEMO_PIN: '550912' }, defaults);
    expect(c).toMatchObject({
      environment: 'staging',
      demo: true,
      migrateOnStart: true,
      storage: { kind: 'local', dir: '/srv/veyra-staging/uploads' },
    });
    expect(problems({ VEYRA_ENV: 'staging', VEYRA_DATA_DIR: 'relative/dir' }).problems).toContain(
      'VEYRA_DATA_DIR must be an absolute path outside development',
    );
  });

  it('the AI reader: off by default, needs its key, and production needs the client agreement', () => {
    const demo = { ...STAGING, VEYRA_DEMO: 'true', VEYRA_DEMO_PIN: '550912' };
    expect(loadConfig(demo, defaults).ai).toBeNull();
    const key = 'AIzaFakeKeyForTests0123456789';
    const on = loadConfig({ ...demo, VEYRA_AI_READER: 'gemini', GEMINI_API_KEY: key }, defaults);
    expect(on.ai).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-pro' });
    // A main model and backups, comma-separated.
    expect(
      loadConfig(
        {
          ...demo,
          VEYRA_AI_READER: 'gemini',
          GEMINI_API_KEY: key,
          VEYRA_AI_MODEL: 'main-model, backup-model',
        },
        defaults,
      ).ai,
    ).toMatchObject({ model: 'main-model', backupModels: ['backup-model'] });
    expect(String(on.ai?.apiKey)).not.toContain(key);
    expect(JSON.stringify(describeConfig(on))).not.toContain(key);
    expect(problems({ ...demo, VEYRA_AI_READER: 'gemini' }).problems).toContain(
      'GEMINI_API_KEY is required when VEYRA_AI_READER is gemini',
    );
    expect(
      problems({ ...PRODUCTION, VEYRA_AI_READER: 'gemini', GEMINI_API_KEY: key }).problems,
    ).toContain(
      'VEYRA_AI_READER sends invoices to Google: set VEYRA_AI_ALLOW_PRODUCTION=true only once the client has agreed',
    );
  });

  it('the demo is a brewery unless VEYRA_DEMO_BUSINESS chooses manufacturing', () => {
    const demo = { ...STAGING, VEYRA_DEMO: 'true', VEYRA_DEMO_PIN: '550912' };
    expect(loadConfig(demo, defaults).demoBusiness).toBe('brewery');
    expect(
      loadConfig({ ...demo, VEYRA_DEMO_BUSINESS: 'manufacturing' }, defaults).demoBusiness,
    ).toBe('manufacturing');
    expect(problems({ ...demo, VEYRA_DEMO_BUSINESS: 'bakery' }).problems).toContain(
      'VEYRA_DEMO_BUSINESS is not valid (one of brewery, manufacturing)',
    );
  });

  it('limits can be tightened, never widened beyond the built-in maximums', () => {
    const c = loadConfig(
      { VEYRA_MAX_UPLOAD_BYTES: String(5 * 1024 * 1024), VEYRA_MAX_PDF_PAGES: '5' },
      defaults,
    );
    expect(c.limits).toMatchObject({ maxUploadBytes: 5 * 1024 * 1024, maxPdfPages: 5 });
    expect(problems({ VEYRA_MAX_PDF_PAGES: '500' }).problems).toEqual([
      'VEYRA_MAX_PDF_PAGES is not valid (a whole number in range)',
    ]);
  });
});

describe('configuration: security (Phase 6C)', () => {
  it('secrets are wrapped: the database URL and the demo PIN never print', () => {
    const c = loadConfig({ ...STAGING, VEYRA_DEMO: 'true', VEYRA_DEMO_PIN: '550912' }, defaults);
    const printed = `${JSON.stringify(c)} ${String(c.database.url)} ${JSON.stringify(describeConfig(c))}`;
    expect(printed).not.toMatch(/db-staging|550912|postgresql:/);
    expect(c.auth.demoPin?.reveal()).toBe('550912');
  });

  it('sessions: configurable idle and absolute lifetimes, idle never longer than absolute', () => {
    const c = loadConfig(
      { VEYRA_SESSION_IDLE_MINUTES: '15', VEYRA_SESSION_ABSOLUTE_HOURS: '8' },
      defaults,
    );
    expect(c.auth.session).toEqual({ idleMs: 15 * 60_000, absoluteMs: 8 * 3_600_000 });
    expect(loadConfig({}, defaults).auth.session).toEqual({
      idleMs: 30 * 60_000,
      absoluteMs: 12 * 3_600_000,
    });
    expect(
      problems({ VEYRA_SESSION_IDLE_MINUTES: '600', VEYRA_SESSION_ABSOLUTE_HOURS: '2' }).problems,
    ).toEqual(['VEYRA_SESSION_IDLE_MINUTES must not be longer than VEYRA_SESSION_ABSOLUTE_HOURS']);
  });

  it('cookies are Secure when deployed and can never be made insecure in production', () => {
    expect(loadConfig({}, defaults).auth.cookieSecure).toBe(false); // http://localhost
    expect(loadConfig(PRODUCTION, defaults).auth.cookieSecure).toBe(true);
    expect(problems({ ...PRODUCTION, VEYRA_COOKIE_SECURE: 'false' }).problems).toEqual([
      'VEYRA_COOKIE_SECURE must not be false in production',
    ]);
  });

  it('origins: required when deployed, exact, https in production, never "*"', () => {
    expect(loadConfig(PRODUCTION, defaults).http).toEqual({
      publicOrigins: ['https://veyra.toit.example'],
      corsOrigins: [],
    });
    expect(problems({ ...PRODUCTION, VEYRA_PUBLIC_ORIGIN: '' }).problems).toEqual([
      'VEYRA_PUBLIC_ORIGIN is required in production (the https:// address users open)',
    ]);
    for (const bad of ['*', 'https://veyra.example.com/app', 'veyra.example.com'])
      expect(problems({ ...PRODUCTION, VEYRA_CORS_ORIGINS: bad }).problems).toEqual([
        'VEYRA_CORS_ORIGINS is not valid (comma-separated origins such as https://veyra.example.com, never *)',
      ]);
    expect(
      problems({ ...PRODUCTION, VEYRA_PUBLIC_ORIGIN: 'http://veyra.toit.example' }).problems,
    ).toEqual(['VEYRA_PUBLIC_ORIGIN and VEYRA_CORS_ORIGINS must be https:// in production']);
  });

  it('the organization is named when deployed (one organization per deployment)', () => {
    expect(problems({ ...PRODUCTION, VEYRA_ORGANIZATION_NAME: '' }).problems).toEqual([
      'VEYRA_ORGANIZATION_NAME is required in production',
    ]);
    expect(loadConfig(PRODUCTION, defaults).organizationName).toBe('Toit');
  });

  it('a deployed demo sets its own PIN; production has no demo PIN at all', () => {
    expect(problems({ ...STAGING, VEYRA_DEMO: 'true' }).problems).toEqual([
      'VEYRA_DEMO_PIN is required when VEYRA_DEMO is true in staging',
    ]);
    expect(loadConfig(PRODUCTION, defaults).auth.demoPin).toBeNull();
    expect(
      loadConfig({ ...PRODUCTION, VEYRA_DEMO_PIN: '123456' }, defaults).auth.demoPin,
    ).toBeNull();
  });

  it('remote PostgreSQL in production must use TLS; a separate migration credential is optional', () => {
    expect(
      problems({ ...PRODUCTION, DATABASE_URL: 'postgres://veyra:x@db.example.com/veyra' }).problems,
    ).toEqual([
      'DATABASE_URL must set sslmode=verify-full (or require) for a database on another host in production',
    ]);
    // Loopback needs no TLS; an explicit waiver is possible (documented risk).
    loadConfig({ ...PRODUCTION, DATABASE_URL: 'postgres://veyra:x@127.0.0.1/veyra' }, defaults);
    loadConfig(
      {
        ...PRODUCTION,
        DATABASE_URL: 'postgres://veyra:x@db.example.com/veyra',
        VEYRA_DB_REQUIRE_TLS: 'false',
      },
      defaults,
    );
    const c = loadConfig(
      {
        ...PRODUCTION,
        DATABASE_MIGRATION_URL: 'postgres://owner:y@db.example.com/veyra?sslmode=verify-full',
      },
      defaults,
    );
    expect(c.database.migrationUrl?.reveal()).toMatch(/^postgres:\/\/owner:/);
    expect(JSON.stringify(c)).not.toMatch(/owner:y/);
  });

  it('the local AI assist stays local unless an operator explicitly allows a remote one', () => {
    for (const url of ['http://127.0.0.1:11434', 'http://ollama:11434', 'http://10.0.3.4:11434'])
      loadConfig({ VEYRA_OLLAMA_URL: url }, defaults);
    expect(problems({ VEYRA_OLLAMA_URL: 'https://ai.example.com' }).problems).toEqual([
      'VEYRA_OLLAMA_URL must be on this machine or a private network (set VEYRA_OLLAMA_ALLOW_REMOTE=true to send documents elsewhere)',
    ]);
    loadConfig(
      { VEYRA_OLLAMA_URL: 'https://ai.example.com', VEYRA_OLLAMA_ALLOW_REMOTE: 'true' },
      defaults,
    );
  });
});

describe('configuration: hosted demo (Phase 7C)', () => {
  it("the platform's PORT is used when VEYRA_API_PORT is not set; VEYRA_API_PORT wins", () => {
    expect(loadConfig({ PORT: '10000' }, defaults).port).toBe(10_000);
    expect(loadConfig({ PORT: '10000', VEYRA_API_PORT: '8080' }, defaults).port).toBe(8080);
    expect(loadConfig({}, defaults).port).toBe(8787);
    expect(problems({ PORT: 'eighty' }).problems).toEqual([
      'PORT is not valid (a whole number in range)',
    ]);
  });

  it('the public demo: staging with the demo, its own PIN, the Vercel origin, no auto-migration', () => {
    const c = loadConfig(
      {
        ...STAGING,
        VEYRA_PUBLIC_ORIGIN: 'https://veyra-demo.vercel.app',
        VEYRA_DEMO: 'true',
        VEYRA_DEMO_PIN: '482913',
        VEYRA_MIGRATE_ON_START: 'false',
        VEYRA_API_HOST: '0.0.0.0',
        PORT: '8080',
        VEYRA_TRUST_PROXY: '2',
      },
      defaults,
    );
    expect(c).toMatchObject({
      environment: 'staging',
      demo: true,
      allowFixtureExtractor: false,
      migrateOnStart: false,
      host: '0.0.0.0',
      port: 8080,
      trustProxy: 2,
      http: { publicOrigins: ['https://veyra-demo.vercel.app'], corsOrigins: [] },
      auth: { cookieSecure: true },
    });
    expect(String(c.auth.demoPin)).not.toContain('482913');
    expect(JSON.stringify(describeConfig(c))).not.toMatch(/482913|vercel|db-staging/);
  });
});

describe('the 5 Invoice Challenge settings', () => {
  it('defaults: 20 a day, 3 per connection, 24 hours after the results, the AI reader if on', () => {
    const c = loadConfig({ VEYRA_CHALLENGE: 'true' }, defaults);
    expect(c.challenge).toMatchObject({
      dailyLimit: 20,
      perAddressLimit: 3,
      resultsHours: 24,
      reader: 'ai',
    });
  });
  it('keeps prospects’ documents on Veyrafy’s server when asked', () => {
    const c = loadConfig(
      {
        VEYRA_CHALLENGE: 'true',
        VEYRA_CHALLENGE_READER: 'local',
        VEYRA_CHALLENGE_PER_ADDRESS: '1',
      },
      defaults,
    );
    expect(c.challenge).toMatchObject({ reader: 'local', perAddressLimit: 1 });
    expect(() =>
      loadConfig({ VEYRA_CHALLENGE: 'true', VEYRA_CHALLENGE_READER: 'gemini' }, defaults),
    ).toThrow(ConfigError);
  });
});
