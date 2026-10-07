/**
 * Starts the public website process (VEYRA_SITE_ONLY=true, entered through main.ts). It serves the
 * built web app with its security headers. Without VEYRA_BLOG nothing else: no database,
 * migrations, ERP, document storage, sign-in or jobs, and DATABASE_URL is not read. With
 * VEYRA_BLOG=true it also opens the blog's own database (docs/BLOG.md).
 */
import { join } from 'node:path';
import { ConfigError, loadSiteConfig, type SiteConfig } from './config';
import { openVeyraDb, type VeyraDatabase } from './db/open';
import { PLATFORM_ORGANIZATION_ID } from './db/schema';
import { SessionStore } from './auth/sessions';
import { Users } from './auth/users';
import { BlogService } from './blog/service';
import { createLogger } from './http/logging';
import { buildSiteServer, type SiteBlog } from './http/site-server';
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
let database: VeyraDatabase | null = null;
try {
  let blog: SiteBlog | null = null;
  if (config.blog) {
    const b = config.blog;
    database = await openVeyraDb({
      url: b.database.url?.reveal() ?? null,
      pgliteDir: join(b.dataDir, 'pgdata'),
      migrate: b.migrateOnStart,
      pool: b.database.pool,
    });
    const sessions = new SessionStore(database.db, b.session);
    blog = {
      service: new BlogService({ db: database.db }),
      sessions,
      users: new Users(database.db, sessions, PLATFORM_ORGANIZATION_ID),
      cookieSecure: b.cookieSecure,
      publicOrigins: b.publicOrigins,
      origin: b.publicOrigins[0] ?? 'https://veyrafy.com',
      loginPerMinute: b.loginPerMinute,
    };
  }
  server = await buildSiteServer({
    web: await loadWebDist(config.webDist),
    hsts: config.hsts,
    release: config.release,
    trustProxy: config.trustProxy,
    log,
    analytics: config.analytics,
    blog,
  });
  await server.listen({ host: config.host, port: config.port });
} catch (error) {
  log.fatal({ err: error }, 'the Veyrafy website could not start');
  process.exit(1);
}
log.info(
  {
    environment: config.environment,
    port: config.port,
    release: config.release,
    blog: config.blog !== null,
  },
  'Veyrafy website started',
);

const stop = (signal: string) => {
  log.info({ signal }, 'shutting down');
  void server
    .close()
    .then(() => database?.close())
    .then(
      () => process.exit(0),
      () => process.exit(1),
    );
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
