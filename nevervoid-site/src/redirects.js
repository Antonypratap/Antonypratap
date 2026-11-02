// One redirect resolver shared by the Cloudflare Pages middleware
// (functions/_middleware.js, generated at build), the local server and the
// verifier, so what is tested is exactly what runs in production.
//
// resolve(pathname, routes) -> { status, location } | null
//   routes.pages   : Set of every served path (exact case)
//   routes.legacy  : { '/old': '/new' } explicit 301s
//   routes.lower   : { '/lowercase-path': '/Exact-Case' } for case-insensitive
//                    lookups, reproducing SmugMug's own 301 behaviour.
export function resolve(pathname, routes) {
  let p = pathname;
  try {
    p = decodeURI(pathname);
  } catch {
    /* keep raw */
  }
  // /index.html, /Page.html -> clean URL
  if (p.endsWith('.html')) {
    const clean = p === '/index.html' ? '/' : p.slice(0, -5);
    if (routes.pages.has(clean)) return { status: 301, location: encodeURI(clean) };
  }
  if (routes.pages.has(p)) return null;
  // Trailing slash -> none (SmugMug used a 302 here; we upgrade to 301).
  if (p.length > 1 && p.endsWith('/')) {
    const t = p.replace(/\/+$/, '') || '/';
    if (routes.pages.has(t)) return { status: 301, location: encodeURI(t) };
    const r = resolve(t, routes);
    if (r) return r;
  }
  const legacy = routes.legacy[p] ?? routes.legacy[p.replace(/\/+$/, '')];
  if (legacy) return { status: 301, location: legacy };
  const lower = routes.lower[p.toLowerCase().replace(/\/+$/, '')];
  if (lower && lower !== p) return { status: 301, location: encodeURI(lower) };
  // SmugMug image-page variants: /Gallery/i-ID/A, /Gallery/i-ID/XL ... -> /Gallery/i-ID
  const variant = /^(.*\/i-[A-Za-z0-9]+)\/[A-Za-z0-9]+$/.exec(p);
  if (variant) return resolve(variant[1], routes) ?? (routes.pages.has(variant[1]) ? { status: 301, location: encodeURI(variant[1]) } : null);
  // Image page not captured in the crawl -> its gallery (better than a 404).
  const orphan = /^(.*)\/i-[A-Za-z0-9]+$/.exec(p);
  if (orphan && orphan[1]) {
    const g = routes.pages.has(orphan[1]) ? orphan[1] : routes.lower[orphan[1].toLowerCase()];
    if (g) return { status: 301, location: encodeURI(g) };
  }
  return null;
}
