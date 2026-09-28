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
      erp: 'fake',
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
    expect(JSON.stringify(describeConfig(c))).not.toMatch(/ollama|srv|internal/);
  });

  it('NODE_ENV=production without VEYRA_ENV is production, never development', () => {
    const e = problems({ NODE_ENV: 'production' });
    expect(e.problems).toEqual(
      expect.arrayContaining([
        'VEYRA_DATA_DIR is required in production',
        'VEYRA_ERP is required in production',
      ]),
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
    const c = loadConfig(
      {
        NODE_ENV: 'production',
        VEYRA_ENV: 'staging',
        VEYRA_DATA_DIR: '/srv/veyra-staging',
        VEYRA_ERP: 'fake',
        VEYRA_DEMO: 'true',
      },
      defaults,
    );
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
