import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import { pino, type Logger } from 'pino';
import { ulid } from '../ids';
import { registerSecurityHeaders } from './security-headers';
import { registerWebApp, type WebFiles } from './web-static';

/**
 * The public website (veyrafy.com), VEYRA_SITE_ONLY=true: the built web app and its security
 * headers, nothing else. It has no database, storage, ERP connector, sign-in, sessions or jobs;
 * it cannot, because none of those are built here. `/api/*` answers only the liveness probes and a
 * health line with the deployed commit; everything else there is a 404 (so a client address that
 * lands here is shown "This Veyrafy address isn't set up." by the web app).
 */
export async function buildSiteServer(options: {
  web: WebFiles;
  hsts: boolean;
  release: string | null;
  trustProxy?: number;
  log?: Logger;
}): Promise<FastifyInstance> {
  const hops = options.trustProxy ?? 0;
  const app = Fastify({
    loggerInstance: (options.log ?? pino({ level: 'silent' })) as FastifyBaseLogger,
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
    genReqId: () => ulid(),
    logController: new LogController({ disableRequestLogging: true }),
  });
  await registerSecurityHeaders(app, { hsts: options.hsts });
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
  });
  app.get('/api/v1/health/live', async () => ({ status: 'ok' }));
  app.get('/api/v1/health', async () => ({ ok: true, site: true, version: options.release }));
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'There is no such endpoint.', requestId: req.id },
    }),
  );
  registerWebApp(app, options.web);
  return app;
}
