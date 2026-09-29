/**
 * Starts the Veyra API and its job worker: `npm run dev:api` (or `npm run demo` for API + web),
 * `npm run start -w @veyra/api` when deployed. Configuration comes from the environment and is
 * validated first (src/config.ts, .env.example); a misconfigured instance does not start.
 */
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { ConfigError, describeConfig, loadConfig, type VeyraConfig } from './config';
import { PendingMigrationsError } from './db/open';
import { createLogger } from './http/logging';
import { createStorage } from './storage';

let config: VeyraConfig;
try {
  config = loadConfig(process.env, {
    dataDir: fileURLToPath(new URL('../../../data/veyra', import.meta.url)),
  });
} catch (error) {
  // Names and rules only: values are never printed (some are secrets).
  console.error(error instanceof ConfigError ? error.message : String(error));
  process.exit(1);
}

const log = createLogger({ level: config.logLevel, environment: config.environment });

let app: Awaited<ReturnType<typeof createApp>>;
try {
  app = await createApp({
    environment: config.environment,
    dataDir: config.dataDir,
    database: { url: config.database.url?.reveal() ?? null, pool: config.database.pool },
    migrate: config.migrateOnStart,
    storage: createStorage(config.storage),
    demo: config.demo,
    allowFixtureExtractor: config.allowFixtureExtractor,
    nodeEnv: process.env.NODE_ENV,
    ollama: config.ollama,
    log,
    limits: config.limits,
    rateLimits: {
      upload: config.rateLimits.uploadsPerMinute,
      processing: config.rateLimits.processingPerMinute,
      dev: config.rateLimits.devPerMinute,
      login: config.rateLimits.loginPerMinute,
    },
    organizationName: config.organizationName,
    auth: {
      session: config.auth.session,
      cookieSecure: config.auth.cookieSecure,
      demoPin: config.auth.demoPin,
      publicOrigins: config.http.publicOrigins,
      corsOrigins: config.http.corsOrigins,
    },
    trustProxy: config.trustProxy,
    jobs: config.jobs,
  });
} catch (error) {
  if (error instanceof PendingMigrationsError) log.fatal({ pending: error.pending }, error.message);
  else log.fatal({ err: error }, 'Veyra could not start');
  process.exit(1);
}

// Storage must be usable before the instance takes traffic.
try {
  await app.storage.check();
} catch (error) {
  log.fatal({ errorCode: (error as { code?: string }).code }, 'document storage is not usable');
  await app.close(0);
  process.exit(1);
}

app.runner.start();
await app.server.listen({ host: config.host, port: config.port });
log.info({ ...describeConfig(config), port: config.port }, 'Veyra API started');
if (config.environment === 'development')
  console.log(`Veyra API on http://${config.host}:${config.port}/api/v1`);

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  try {
    await app.close();
    log.info('stopped');
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'shutdown did not complete cleanly');
    process.exit(1);
  }
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('unhandledRejection', (error) => {
  log.error({ err: error }, 'unhandled rejection');
});
