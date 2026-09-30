/**
 * Starts the public website process (VEYRA_SITE_ONLY=true, entered through main.ts). It serves the
 * built web app with its security headers and nothing else: no database, migrations, ERP,
 * document storage, sign-in or jobs. DATABASE_URL and the application settings are not read.
 */
import { ConfigError, loadSiteConfig, type SiteConfig } from './config';
import { createLogger } from './http/logging';
import { buildSiteServer } from './http/site-server';
import { loadWebDist } from './http/web-static';

let config: SiteConfig;
try {
  config = loadSiteConfig(process.env);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : String(error));
  process.exit(1);
}

const log = createLogger({ level: config.logLevel, environment: config.environment });
let server: Awaited<ReturnType<typeof buildSiteServer>>;
try {
  server = await buildSiteServer({
    web: await loadWebDist(config.webDist),
    hsts: config.hsts,
    release: config.release,
    trustProxy: config.trustProxy,
    log,
  });
  await server.listen({ host: config.host, port: config.port });
} catch (error) {
  log.fatal({ err: error }, 'the Veyrafy website could not start');
  process.exit(1);
}
log.info(
  { environment: config.environment, port: config.port, release: config.release },
  'Veyrafy website started',
);

const stop = (signal: string) => {
  log.info({ signal }, 'shutting down');
  void server.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
