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
  VEYRA_STORAGE: 's3',
  VEYRA_S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
  VEYRA_S3_REGION: 'eu-west-1',
  VEYRA_S3_BUCKET: 'veyra-documents-prod',
  VEYRA_S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID',
  VEYRA_S3_SECRET_ACCESS_KEY: 'super-secret-value-do-not-print',
  VEYRA_ERP: 'fake',
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
      storage: { kind: 's3', s3: { bucket: 'veyra-documents-prod', forcePathStyle: false } },
    });
    expect(JSON.stringify(describeConfig(c))).not.toMatch(/secret|AKIA|amazonaws|srv/);
  });

  it('NODE_ENV=production without VEYRA_ENV is production, never development', () => {
    const e = problems({ NODE_ENV: 'production' });
    expect(e.problems).toEqual(
      expect.arrayContaining([
        'VEYRA_DATA_DIR is required in production',
        'VEYRA_STORAGE is required in production (local or s3)',
        'VEYRA_ERP is required in production',
      ]),
    );
  });

  it('refuses the demo, fixtures and plain-http storage in production', () => {
    const e = problems({
      ...PRODUCTION,
      VEYRA_DEMO: 'true',
      VEYRA_ALLOW_FIXTURE_EXTRACTOR: 'true',
      VEYRA_S3_ENDPOINT: 'http://minio.internal:9000',
    });
    expect(e.problems).toEqual([
      'VEYRA_S3_ENDPOINT must use https in production',
      'VEYRA_DEMO must not be true in production',
      'VEYRA_ALLOW_FIXTURE_EXTRACTOR must not be true in production',
    ]);
  });

  it('s3 storage requires all of its settings', () => {
    const rest = Object.fromEntries(
      Object.entries(PRODUCTION).filter(
        ([k]) => k !== 'VEYRA_S3_SECRET_ACCESS_KEY' && k !== 'VEYRA_S3_BUCKET',
      ),
    );
    expect(problems(rest).problems).toEqual([
      'VEYRA_S3_BUCKET is required when VEYRA_STORAGE=s3',
      'VEYRA_S3_SECRET_ACCESS_KEY is required when VEYRA_STORAGE=s3',
    ]);
  });

  it('invalid values are reported by name and rule, never with the value (secrets stay secret)', () => {
    const e = problems({
      ...PRODUCTION,
      VEYRA_API_PORT: '99999',
      VEYRA_ENV: 'prod',
      VEYRA_S3_BUCKET: 'Bad_Bucket!',
      VEYRA_MAX_UPLOAD_BYTES: String(500 * 1024 * 1024),
      VEYRA_LOG_LEVEL: 'verbose',
    });
    expect(e.problems).toEqual(
      expect.arrayContaining([
        'VEYRA_API_PORT is not valid (a whole number in range)',
        'VEYRA_ENV is not valid (one of development, staging, production)',
        'VEYRA_S3_BUCKET is not valid (see .env.example)',
        'VEYRA_MAX_UPLOAD_BYTES is not valid (a whole number in range)',
        'VEYRA_LOG_LEVEL is not valid (one of fatal, error, warn, info, debug, silent)',
      ]),
    );
    expect(e.message).not.toMatch(/99999|Bad_Bucket|super-secret|AKIA/);
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
        VEYRA_STORAGE: 'local',
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
