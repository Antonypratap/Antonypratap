/**
 * Checks `apps/web/vercel.json` (Phase 7C, docs/DEPLOYMENT.md "Public demo"). It runs in the build
 * on Vercel (vite.config.ts) and in the tests, so the deployed site cannot drift from the
 * reviewed policy:
 *
 * - `/api/*` is forwarded to the Veyra API host (same origin for the browser: first-party
 *   session cookie, `connect-src 'self'`), and that host is a real https:// one. The committed
 *   placeholder (`*.invalid`) fails the build on Vercel instead of deploying a demo that cannot
 *   reach its API.
 * - Every other path falls back to index.html (the single-page app; direct links and refreshes).
 * - Every page gets exactly the security headers of security-headers.ts, plus HSTS. API responses
 *   keep the API's own headers (the rule excludes /api/).
 * - vercel.json holds no environment variables (secrets never go in Git).
 */
export const PLACEHOLDER_SUFFIX = '.invalid';
export const HSTS = 'max-age=31536000';

interface Rewrite {
  source: string;
  destination: string;
}
interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}
interface VercelJson {
  framework?: string;
  rewrites?: Rewrite[];
  headers?: HeaderRule[];
  env?: unknown;
  build?: { env?: unknown };
}

export function vercelConfigProblems(
  raw: unknown,
  expectedHeaders: Record<string, string>,
  opts: { allowPlaceholder?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const v = (raw ?? {}) as VercelJson;
  if (v.framework !== 'vite') problems.push('framework must be "vite"');
  if (v.env !== undefined || v.build?.env !== undefined)
    problems.push(
      'vercel.json must not set environment variables (use the Vercel project settings)',
    );

  const rewrites = v.rewrites ?? [];
  const api = rewrites[0];
  if (api?.source !== '/api/:path*')
    problems.push('the first rewrite must forward /api/:path* to the Veyra API');
  else {
    let url: URL | null = null;
    try {
      url = new URL(api.destination.replace(':path*', 'x'));
    } catch {
      problems.push('the /api rewrite destination is not a URL');
    }
    if (url) {
      if (url.protocol !== 'https:') problems.push('the /api rewrite must use https://');
      if (url.username || url.password) problems.push('the /api rewrite must not hold credentials');
      if (!api.destination.endsWith('/api/:path*'))
        problems.push('the /api rewrite must end with /api/:path*');
      if (url.hostname.endsWith(PLACEHOLDER_SUFFIX) && !opts.allowPlaceholder)
        problems.push(
          'the /api rewrite still points at the placeholder host: set your Veyra API host in apps/web/vercel.json (docs/DEPLOYMENT.md "Public demo")',
        );
    }
  }
  const spa = rewrites.at(-1);
  if (rewrites.length !== 2 || spa?.source !== '/(.*)' || spa.destination !== '/index.html')
    problems.push(
      'the rewrites must be exactly: /api/:path* to the API, then /(.*) to /index.html',
    );

  const pages = (v.headers ?? []).find((h) => h.source === '/((?!api/).*)');
  if (!pages) problems.push('a header rule for every page except /api/ is missing');
  else {
    const got = Object.fromEntries(pages.headers.map((h) => [h.key, h.value]));
    const want = { ...expectedHeaders, 'Strict-Transport-Security': HSTS };
    for (const [key, value] of Object.entries(want))
      if (got[key] !== value) problems.push(`header ${key} differs from security-headers.ts`);
    for (const key of Object.keys(got))
      if (!(key in want)) problems.push(`header ${key} is not in security-headers.ts`);
  }
  return problems;
}

export function checkVercelConfig(raw: unknown, expectedHeaders: Record<string, string>): void {
  const problems = vercelConfigProblems(raw, expectedHeaders);
  if (problems.length > 0)
    throw new Error(`apps/web/vercel.json is not deployable:\n  - ${problems.join('\n  - ')}`);
}
