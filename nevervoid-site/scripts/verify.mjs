// Migration verifier: tests every old nevervoid.com URL against the new build
// and checks on-page SEO. Writes reports/migration-report.{csv,md}.
//   node scripts/build.mjs && node scripts/verify.mjs
// Exit code 1 if any check fails.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createServer } from './serve.mjs';
import { KEYWORD_REDIRECTS, LEGACY } from '../src/site-map.js';
import { applyFixes, REMOVED } from '../src/content-fixes.js';

const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ORIGIN = 'https://www.nevervoid.com';
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const oldPages = read('data/pages.json');
const fixedTitle = new Map(applyFixes(read('data/pages.json')).pages.map((p) => [p.path, p.title]));
const unlisted = fs.existsSync(path.join(ROOT, 'data/unlisted-links.json')) ? read('data/unlisted-links.json') : [];
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, '_manifest.json'), 'utf8'));
const gscFile = path.join(ROOT, 'data/gsc-pages.csv'); // optional Search Console export (Pages tab)

const server = createServer().listen(0);
const port = server.address().port;
const get = (p) =>
  new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port, path: encodeURI(p).replace(/%25/g, '%') }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (d) => (body += d));
        r.on('end', () => res({ status: r.statusCode, location: r.headers.location, body }));
      })
      .on('error', rej);
  });
async function follow(p) {
  const chain = [];
  let cur = p;
  for (let i = 0; i < 6; i++) {
    const r = await get(cur);
    if (r.status >= 300 && r.status < 400) {
      chain.push(r.status);
      cur = decodeURI(new URL(r.location, 'http://x').pathname);
      continue;
    }
    return { chain, status: r.status, final: cur, body: r.body };
  }
  return { chain, status: 'LOOP', final: cur, body: '' };
}

const failures = [];
const fail = (url, msg) => failures.push(`${url}: ${msg}`);

// ---------- optional Search Console data ----------
const gsc = new Map();
if (fs.existsSync(gscFile)) {
  const [head, ...rows] = fs.readFileSync(gscFile, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',').map((c) => c.replace(/"/g, '').trim().toLowerCase());
  for (const row of rows) {
    const v = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, '').replace(/^"|"$/g, ''));
    const url = v[cols.findIndex((c) => /page|url/.test(c))];
    const pick = (re) => v[cols.findIndex((c) => re.test(c))];
    gsc.set(new URL(url).pathname.replace(/\/$/, '') || '/', `${pick(/click/)} clicks / ${pick(/impression/)} impr / pos ${pick(/position/)}`);
  }
}
const gscFor = (p) => gsc.get(p) ?? (gsc.size ? '0 clicks (not in export)' : 'PENDING: no Search Console access yet');

// ---------- 1. every old URL ----------
const rows = [];
const built = new Map(manifest.pages.map((p) => [p.path, p]));
for (const old of oldPages) {
  const r = await follow(old.path);
  if (old.path in REMOVED) {
    const ok = r.status === 200 && r.chain.length === 1 && r.chain[0] === 301 && r.final === REMOVED[old.path];
    if (!ok) fail(old.path, `removed page should 301 to ${REMOVED[old.path]}, got ${r.chain.join('>')} ${r.status} ${r.final}`);
    rows.push({ existing: ORIGIN + old.path, gsc: gscFor(old.path), title: old.title, dest: ORIGIN + r.final, redirect: r.chain.join(' > ') + ' redirect (page removed at owner request)', verify: ok ? 'PASS' : 'FAIL', note: 'removed' });
    continue;
  }
  const okPath = r.final === old.path && r.chain.length === 0 && r.status === 200;
  if (!okPath) fail(old.path, `expected 200 at same URL, got ${r.chain.join('>')}${r.chain.length ? '>' : ''}${r.status} at ${r.final}`);
  const nb = built.get(old.path);
  const expectTitle = fixedTitle.get(old.path);
  const titleKept = nb && nb.title === expectTitle;
  if (!titleKept) fail(old.path, `title "${nb?.title}", expected "${expectTitle}"`);
  rows.push({
    existing: ORIGIN + (old.path === '/' ? '/' : old.path),
    gsc: gscFor(old.path),
    title: old.title,
    dest: ORIGIN + (r.final === '/' ? '/' : r.final),
    redirect: r.chain.length ? `${r.chain.join(' > ')} redirect` : 'none (URL preserved)',
    verify: okPath && titleKept ? 'PASS' : 'FAIL',
    note: `${nb?.template ?? ''}; description ${nb?.descSource ?? ''}${expectTitle !== old.title ? `; title updated at owner request: "${expectTitle}"` : ''}`,
  });
}

// ---------- 2. URL variants of every preserved page ----------
let variants = 0;
for (const old of oldPages) {
  if (old.path === '/') continue;
  const tests = [old.path + '/', old.path.toLowerCase(), old.path + '.html', old.path.toUpperCase()];
  if (old.path in REMOVED) continue;
  for (const v of tests) {
    if (v === old.path) continue;
    const r = await follow(v);
    variants++;
    // For paths that differ only in case from another page, the case variant
    // legitimately lands on the other page (documented in src/site-map.js).
    const collision = oldPages.some((o) => o.path !== old.path && o.path.toLowerCase() === old.path.toLowerCase());
    if (r.status !== 200 || r.chain.length > 1 || (!collision && r.final !== old.path)) fail(v, `variant -> ${r.chain.join('>')} ${r.status} ${r.final}`);
  }
}

// ---------- 3. legacy, keyword and linked-but-unlisted URLs ----------
const legacyRows = [];
const legacyUrls = [...new Set([...Object.keys(LEGACY), ...Object.keys(KEYWORD_REDIRECTS).map((k) => `/keyword/${k}`), ...unlisted.map((u) => decodeURIComponent(u))])];
for (const u of legacyUrls) {
  const r = await follow(u);
  const ok = r.status === 200 && r.chain.length === 1 && r.chain[0] === 301;
  if (!ok) fail(u, `legacy -> ${r.chain.join('>')} ${r.status} ${r.final}`);
  legacyRows.push({ existing: ORIGIN + u, gsc: gscFor(u), title: '(not a page on the old sitemap)', dest: ORIGIN + r.final, redirect: r.chain.join(' > ') || 'none', verify: ok ? 'PASS' : 'FAIL', note: 'legacy / SmugMug system URL' });
}

// ---------- 4. every image page seen on the old site ----------
let imgOk = 0,
  imgRedirect = 0;
for (const old of oldPages)
  for (const ip of old.imagePages ?? []) {
    const r = await follow(ip);
    if (r.status !== 200) fail(ip, `image page -> ${r.status}`);
    else if (r.chain.length) {
      imgRedirect++;
      const gallery = ip.slice(0, ip.lastIndexOf('/i-'));
      if (r.final.toLowerCase() !== gallery.toLowerCase()) fail(ip, `image page redirected to ${r.final}, not its gallery ${gallery}`);
    } else imgOk++;
  }
// image-size variants, e.g. /Gallery/i-ID/A
{
  const sample = oldPages.find((p) => p.imagePages?.length);
  const r = await follow(sample.imagePages[0] + '/A');
  if (r.status !== 200 || r.final !== sample.imagePages[0]) fail(sample.imagePages[0] + '/A', `size variant -> ${r.status} ${r.final}`);
}

// ---------- 5. on-page SEO for every page in the new site ----------
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const internalLinks = new Set();
let imgs = 0,
  missingAlt = 0;
for (const pg of manifest.pages) {
  const r = await follow(pg.path);
  const h = r.body;
  const h1s = h.match(/<h1[\s>]/g) ?? [];
  if (h1s.length !== 1) fail(pg.path, `${h1s.length} <h1> elements`);
  if (!/<title>[^<]{10,}<\/title>/.test(h)) fail(pg.path, 'missing title');
  if (!/<meta name="description" content="[^"]{50,}">/.test(h)) fail(pg.path, 'missing/short meta description');
  const can = /<link rel="canonical" href="([^"]+)">/.exec(h)?.[1];
  if (decodeURI(can ?? '') !== ORIGIN + (pg.path === '/' ? '' : pg.path)) fail(pg.path, `canonical ${can}`);
  for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      if (!j['@context'] || !Array.isArray(j['@graph'])) fail(pg.path, 'JSON-LD without @context/@graph');
    } catch (e) {
      fail(pg.path, 'invalid JSON-LD: ' + e.message);
    }
  }
  if (/photos\.smugmug\.com|smugmug\.com\/photos/.test(h)) fail(pg.path, 'still references SmugMug-hosted images');
  for (const m of h.matchAll(/(?:src|srcset|content)="([^"]*\/img\/[^"]+)"/g))
    for (const u of m[1].split(',').map((x) => x.trim().split(' ')[0])) {
      const f = path.join(DIST, decodeURI(new URL(u, ORIGIN).pathname));
      if (!fs.existsSync(f)) fail(pg.path, `missing image file ${u}`);
    }
  for (const m of h.matchAll(/<img\b[^>]*>/g)) {
    if (!/hero-bg/.test(m[0]) && !/ width="\d+" height="\d+"/.test(m[0])) fail(pg.path, 'img without width/height');
    imgs++;
    const alt = /alt="([^"]*)"/.exec(m[0]);
    if (!alt) fail(pg.path, 'img without alt attribute');
    else if (!alt[1] && !/hero-bg/.test(m[0])) missingAlt++;
  }
  for (const m of h.matchAll(/href="(\/[^"#?]*)/g)) internalLinks.add(decode(m[1]));
}
if (missingAlt) fail('(site)', `${missingAlt} content images with empty alt`);
let brokenLinks = 0;
for (const l of internalLinks) {
  const r = await follow(decodeURI(l));
  if (r.status !== 200) {
    brokenLinks++;
    fail(l, `internal link -> ${r.status}`);
  } else if (r.chain.length) fail(l, `internal link goes through a redirect to ${r.final}; link directly`);
}

// ---------- 6. sitemap ----------
const sm = fs.readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8');
if (!sm.startsWith('<?xml') || !sm.trim().endsWith('</urlset>')) fail('sitemap.xml', 'not a well-formed urlset');
if ((sm.match(/<url>/g) ?? []).length !== (sm.match(/<\/url>/g) ?? []).length) fail('sitemap.xml', 'unbalanced <url>');
const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]));
if (locs.length > 50000 || Buffer.byteLength(sm) > 50 * 1024 * 1024) fail('sitemap.xml', 'exceeds protocol limits');
for (const loc of locs) {
  if (!loc.startsWith(ORIGIN)) fail(loc, 'sitemap URL not on www.nevervoid.com');
  const p = decodeURI(new URL(loc).pathname) || '/';
  const r = await follow(p);
  if (r.status !== 200 || r.chain.length) fail(loc, `sitemap URL -> ${r.chain.join('>')} ${r.status}`);
  if (/noindex/.test(/<meta name="robots" content="([^"]+)">/.exec(r.body)?.[1] ?? '')) fail(loc, 'noindex page in sitemap');
}
for (const old of oldPages) if (!(old.path in REMOVED) && !locs.includes(ORIGIN + (old.path === '/' ? '' : encodeURI(old.path))) && !locs.includes(ORIGIN + old.path)) fail(old.path, 'preserved page missing from new sitemap');
const imageEntries = (sm.match(/<image:loc>/g) ?? []).length;

server.close();

// ---------- report ----------
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
const all = [...rows, ...legacyRows];
const csvq = (s) => `"${String(s).replace(/"/g, '""')}"`;
fs.writeFileSync(
  path.join(ROOT, 'reports/migration-report.csv'),
  ['Existing URL,Google Search Console performance,Existing page title,New destination URL,Redirect status,Migration verification status,Notes', ...all.map((r) => [r.existing, r.gsc, r.title, r.dest, r.redirect, r.verify, r.note].map(csvq).join(','))].join('\n') + '\n',
);
const pass = all.filter((r) => r.verify === 'PASS').length;
const md = `# Nevervoid migration verification

Generated by \`npm run verify\` against the local build (same redirect code as production).

| Check | Result |
|---|---|
| Old sitemap URLs served at the identical URL (200, no redirect) | ${rows.filter((r) => r.verify === 'PASS' && r.note !== 'removed').length} / ${rows.filter((r) => r.note !== 'removed').length} |
| Old pages removed at owner request (301) | ${Object.entries(REMOVED).map(([a, b]) => `${a} → ${b}`).join(', ')} |
| Legacy, keyword and linked-but-unlisted URLs that 301 to a live page | ${legacyRows.filter((r) => r.verify === 'PASS').length} / ${legacyRows.length} |
| Trailing-slash, lowercase, UPPERCASE and .html variants tested | ${variants} |
| Old image pages served at the identical URL | ${imgOk} |
| Old image pages 301 to their gallery (image not captured in crawl) | ${imgRedirect} |
| Pages checked for one H1, title, description, canonical, valid JSON-LD | ${manifest.pages.length} |
| Images checked for alt text | ${imgs} |
| Internal links checked (broken) | ${internalLinks.size} (${brokenLinks}) |
| Sitemap URLs (all 200, indexable, canonical) / image entries | ${locs.length} / ${imageEntries} |
| Search Console data | ${gsc.size ? `${gsc.size} URLs merged from data/gsc-pages.csv` : 'NOT AVAILABLE: export the Pages report to data/gsc-pages.csv and re-run'} |
| **Failures** | **${failures.length}** |

${failures.length ? '## Failures\n\n' + failures.map((f) => `- ${f}`).join('\n') + '\n' : ''}
## URL-by-URL report

| Existing URL | GSC performance | Existing page title | New destination URL | Redirect | Verified |
|---|---|---|---|---|---|
${all.map((r) => `| ${r.existing} | ${r.gsc} | ${r.title.replace(/\|/g, '\\|')} | ${r.dest} | ${r.redirect} | ${r.verify} |`).join('\n')}
`;
fs.writeFileSync(path.join(ROOT, 'reports/migration-report.md'), md);
console.log(`URLs: ${pass}/${all.length} pass · variants ${variants} · image pages ${imgOk} same-URL + ${imgRedirect} -> gallery · links ${internalLinks.size} · sitemap ${locs.length} (${imageEntries} images)`);
if (failures.length) {
  console.log(`\n${failures.length} FAILURES:\n` + failures.slice(0, 60).join('\n'));
  process.exitCode = 1;
}

// ---------- 7. the generated Cloudflare Pages middleware itself ----------
{
  const { onRequest } = await import('../functions/_middleware.js');
  const env = { ASSETS: { fetch: async () => new Response(fs.readFileSync(path.join(DIST, '_routes-data.json'))) } };
  const run = (u) => onRequest({ request: new Request(u), env, next: async () => new Response('asset', { status: 200 }) });
  const cases = [
    ['https://www.nevervoid.com/Fitness-Photography', 200, null],
    ['https://www.nevervoid.com/fitness-photography', 301, 'https://www.nevervoid.com/Fitness-Photography'],
    ['https://www.nevervoid.com/Headshot-photographer-bangalore/?utm_source=x', 301, 'https://www.nevervoid.com/Headshot-photographer-bangalore?utm_source=x'],
    ['https://nevervoid.com/About', 301, 'https://www.nevervoid.com/About'],
    ['https://www.nevervoid.com/Corporate-Photography', 301, 'https://www.nevervoid.com/Corporate-photoshoot'],
    ['https://www.nevervoid.com/keyword/maternity%20photography', 301, 'https://www.nevervoid.com/Maternity-Photography'],
    ['https://www.nevervoid.com/food-photography', 301, 'https://www.nevervoid.com/Food-photography'],
    ['https://www.nevervoid.com/does-not-exist', 200, null], // falls through to the asset server's 404 page
  ];
  let mwFail = 0;
  for (const [u, st, loc] of cases) {
    const r = await run(u);
    if (r.status !== st || (loc && r.headers.get('location') !== loc)) {
      mwFail++;
      console.log(`MIDDLEWARE FAIL ${u}: ${r.status} ${r.headers.get('location')}`);
    }
  }
  console.log(`middleware: ${cases.length - mwFail}/${cases.length} cases pass`);
  if (mwFail) process.exit(1);
}

if (!process.exitCode) console.log('ALL CHECKS PASSED');
