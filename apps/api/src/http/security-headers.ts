import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';

/**
 * Security headers (maintained library). API responses are JSON and documents, never pages: the
 * strictest policy. The web app's pages, when this server also serves them (web-static.ts), get
 * the web app's own policy on top. HSTS whenever the instance is served over HTTPS.
 */
export async function registerSecurityHeaders(
  app: FastifyInstance,
  options: { hsts: boolean },
): Promise<void> {
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    hsts: options.hsts ? { maxAge: 31_536_000, includeSubDomains: false } : false,
  });
}
