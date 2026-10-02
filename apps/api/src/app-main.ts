/**
 * Starts a Veyrafy instance: the API, its job worker and (when VEYRA_WEB_DIST is set) the web app
 * on the same origin. Entered through main.ts. Configuration comes from the environment and is
 * validated first (src/config.ts, .env.example); a misconfigured instance does not start.
 */
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { ConfigError, describeConfig, loadConfig, type VeyraConfig } from './config';
import { PendingMigrationsError } from './db/open';
import { createLogger } from './http/logging';
import { createStorage } from './storage';
import { loadWebDist } from './http/web-static';

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

// The web app this instance serves on its own origin (production client instances).
let web: Awaited<ReturnType<typeof loadWebDist>> | null = null;
if (config.web.dist) {
  try {
    web = await loadWebDist(config.web.dist);
  } catch (error) {
    log.fatal({ err: error }, 'the web app could not be loaded');
    process.exit(1);
  }
}

let app: Awaited<ReturnType<typeof createApp>>;
try {
  app = await createApp({
    environment: config.environment,
    dataDir: config.dataDir,
    database: { url: config.database.url?.reveal() ?? null, pool: config.database.pool },
    migrate: config.migrateOnStart,
    storage: createStorage(config.storage),
    demo: config.demo,
    demoBusiness: config.demoBusiness,
    allowFixtureExtractor: config.allowFixtureExtractor,
    nodeEnv: process.env.NODE_ENV,
    ollama: config.ollama,
    ai: config.ai
      ? {
          apiKey: config.ai.apiKey.reveal(),
          model: config.ai.model,
          backupModels: config.ai.backupModels,
        }
      : null,
    // Several invoices are read at once (the AI or OCR); checking and recording stay serial.
    readAhead: 3,
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
    web,
    release: config.release,
  });
} catch (error) {
  if (error instanceof PendingMigrationsError) log.fatal({ pending: error.pending }, error.message);
  else log.fatal({ err: error }, 'Veyrafy could not start');
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

// The document readers are loaded before the instance takes traffic (Phase 7): otherwise the first
// invoice after a start would wait about a second for them.
const warm = Date.now();
await app.warmUp().then(
  () => log.info({ durationMs: Date.now() - warm }, 'document readers loaded'),
  (error: unknown) =>
    log.warn(
      { errorCode: (error as { code?: string }).code ?? 'WARMUP_FAILED' },
      'document readers not preloaded',
    ),
);

app.runner.start();
await app.server.listen({ host: config.host, port: config.port });
log.info(
  { ...describeConfig(config), port: config.port, web: web !== null, release: config.release },
  'Veyrafy API started',
);
if (config.environment === 'development')
  console.log(`Veyrafy API on http://${config.host}:${config.port}/api/v1`);
// Storage that lost files (a data directory that is not a persistent volume) is said loudly at
// start, before anyone opens an invoice and finds its original missing.
void app.veyra
  .missingDocumentFiles()
  .then(({ checked, missing }) => {
    if (missing > 0)
      log.error(
        { checked, missing },
        'document files are missing from storage: is VEYRA_DATA_DIR a persistent volume?',
      );
  })
  .catch(() => undefined);

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
