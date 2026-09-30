import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { webSecurityHeaders } from '@veyra/web/security-headers';

/**
 * Serves the built web app (`apps/web/dist`) from the API's own origin, so a client instance is one
 * same-origin application: the browser loads the app and calls /api/v1 on the same address, with
 * the same session cookie and CSRF rules as before, and nothing ever depends on 127.0.0.1.
 *
 * Every file of the build is read into memory once, at startup. A request is answered only with
 * one of those exact files (or the app's index.html for an app route), so no request path ever
 * reaches the file system: path traversal has nothing to traverse. Suspicious paths are still
 * refused explicitly (400), so they are visible in the logs.
 */
export interface WebFiles {
  /** URL path (`/assets/index-abc.js`) → file. */
  files: ReadonlyMap<string, WebFile>;
  index: WebFile;
}

interface WebFile {
  body: Buffer;
  type: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Content-hashed build output: cached for a year and never revalidated. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** index.html and the other un-hashed files: always revalidated, so a new release shows at once. */
const REVALIDATE = 'no-cache';

/** The app's own routes and the website's pages: served index.html (the app decides the screen). */
const APP_ROUTE = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._~-]*)*)?$/;

export class WebDistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebDistError';
  }
}

/** Reads a web build into memory. Refuses a directory without index.html or with odd files. */
export async function loadWebDist(dir: string): Promise<WebFiles> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory())
    throw new WebDistError('VEYRA_WEB_DIST is not a directory holding the web build');
  const files = new Map<string, WebFile>();
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const type = TYPES[extname(entry.name).toLowerCase()];
        if (!type) continue; // only known web file types are ever served
        const path = `/${relative(dir, full).split(sep).join('/')}`;
        files.set(path, { body: await readFile(full), type });
      }
    }
  };
  await walk(dir);
  const index = files.get('/index.html');
  if (!index) throw new WebDistError('VEYRA_WEB_DIST has no index.html (build the web app first)');
  return { files, index };
}

/**
 * Registers the web app on `app` for every GET/HEAD path outside /api. `/api/*` paths the API does
 * not have stay the API's JSON 404. Security headers are the web app's own policy
 * (`webSecurityHeaders()`, the same object Vercel and `vite preview` send), never a copy.
 */
export function registerWebApp(app: FastifyInstance, web: WebFiles): void {
  const headers = webSecurityHeaders();
  const send = (reply: FastifyReply, file: WebFile, cache: string) =>
    reply
      .headers({ ...headers, 'content-type': file.type, 'cache-control': cache })
      .send(file.body);

  app.get('/*', { config: { access: 'public' } }, async (req, reply) => {
    const raw = req.url.split('?')[0] ?? '/';
    if (raw === '/api' || raw.startsWith('/api/')) return reply.callNotFound();
    // Encoded dots, separators and NUL have no place in an app route or a build file name.
    if (/%2e|%2f|%5c|%00/i.test(raw))
      return reply.status(400).send({ error: { code: 'BAD_PATH', message: 'Bad path.' } });
    let path: string;
    try {
      path = decodeURIComponent(raw);
    } catch {
      return reply.status(400).send({ error: { code: 'BAD_PATH', message: 'Bad path.' } });
    }
    if (
      path.includes('\0') ||
      path.includes('\\') ||
      path.includes('//') ||
      path.split('/').some((s) => s === '..' || s === '.')
    )
      return reply.status(400).send({ error: { code: 'BAD_PATH', message: 'Bad path.' } });
    const file = web.files.get(path);
    if (file) return send(reply, file, path.startsWith('/assets/') ? IMMUTABLE : REVALIDATE);
    // A missing file (a stale asset name, a typo) is a 404, never the app's page.
    if (path.startsWith('/assets/') || extname(path) !== '' || !APP_ROUTE.test(path))
      return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    return send(reply, web.index, REVALIDATE);
  });
}
