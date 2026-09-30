/**
 * Where the web app finds the Veyrafy API (Phase 7C, docs/DEPLOYMENT.md "Public demo").
 *
 * `VITE_API_BASE_URL` is read at BUILD time and ends up in the public JavaScript: it is an
 * address, never a secret. Two forms:
 *
 * - a path on the same origin, `/api/v1` (the default). The host in front (Vercel rewrites, Caddy,
 *   Nginx) forwards it to the API. The session cookie stays first-party, and CSP stays
 *   `connect-src 'self'`. This is the recommended setup.
 * - an absolute `https://…/api/v1` on ANOTHER origin of the same site (for example
 *   `https://api.veyra.example.com/api/v1` for `https://app.veyra.example.com`). The API must then
 *   list the web origin in `VEYRA_CORS_ORIGINS`. The session cookie is SameSite=Strict, so an API
 *   on a different site (another registrable domain) cannot work, by design.
 */
export const DEFAULT_API_BASE = '/api/v1';

export interface ApiBase {
  /** Prefix for every request: `/api/v1` or `https://api.example.com/api/v1` (no trailing slash). */
  base: string;
  /** The API's origin when it is not this page's origin (for CSP and credentials), else null. */
  origin: string | null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Validates `VITE_API_BASE_URL`. Throws with the rule (never guesses) when it is not usable. */
export function parseApiBase(raw: string | undefined): ApiBase {
  const value = (raw ?? '').trim();
  if (value === '') return { base: DEFAULT_API_BASE, origin: null };
  const fail = (why: string): never => {
    throw new Error(`VITE_API_BASE_URL is not valid: ${why}`);
  };
  if (value.startsWith('/')) {
    if (value.startsWith('//')) fail('a path must start with a single "/"');
    if (!/^\/[\w\-./]*$/.test(value)) fail('a path may contain only letters, digits, - _ . /');
    return { base: value.replace(/\/+$/, ''), origin: null };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('use a path such as /api/v1, or an https:// URL');
  }
  if (url.username || url.password) fail('it must not contain credentials');
  if (url.search || url.hash) fail('it must not contain a query or fragment');
  const local = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    fail('it must be https:// (http:// only for localhost)');
  return { base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, origin: url.origin };
}

/**
 * Only this variable may be given to the web build. Anything else prefixed VITE_ would be
 * published in the JavaScript, so the build refuses it rather than risk shipping a secret.
 */
export const ALLOWED_WEB_ENV = ['VITE_API_BASE_URL'] as const;

export function refuseUnknownWebEnv(env: Readonly<Record<string, string | undefined>>): void {
  const unknown = Object.keys(env).filter(
    (k) => k.startsWith('VITE_') && !(ALLOWED_WEB_ENV as readonly string[]).includes(k),
  );
  if (unknown.length > 0)
    throw new Error(
      `The web build takes only ${ALLOWED_WEB_ENV.join(', ')}; refusing ${unknown.join(', ')} ` +
        '(every VITE_ variable is published in the JavaScript; secrets belong to the API).',
    );
}
