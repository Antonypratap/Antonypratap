// Test every old nevervoid.com URL against a deployed copy of the new site.
//   node scripts/check-live.mjs https://nevervoid-site.pages.dev
//   node scripts/check-live.mjs https://www.nevervoid.com        (after cutover)
// Read-only GET requests, 4 at a time. Exit code 1 on any failure.
// Behind a proxy, run with NODE_USE_ENV_PROXY=1.
import fs from 'node:fs';
import path from 'node:path';
import { KEYWORD_REDIRECTS, LEGACY } from '../src/site-map.js';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node scripts/check-live.mjs <base-url>');
  process.exit(2);
}
const ROOT = path.join(import.meta.dirname, '..');
const pages = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pages.json'), 'utf8'));
const sampleImages = pages.flatMap((p) => (p.imagePages ?? []).slice(0, 2));

const tests = [
  ...pages.map((p) => ({ url: p.path, expect: p.path, hops: 0, title: p.title })),
  ...pages.filter((p) => p.path !== '/').map((p) => ({ url: p.path + '/', expect: p.path, hops: 1 })),
  ...Object.entries(LEGACY).map(([u, d]) => ({ url: u, expect: d, hops: 1 })),
  ...Object.entries(KEYWORD_REDIRECTS).map(([k, d]) => ({ url: `/keyword/${encodeURIComponent(k)}`, expect: d, hops: 1 })),
  ...sampleImages.map((u) => ({ url: u, expect: u, hops: 0 })),
];

async function run(t) {
  let url = base + encodeURI(decodeURI(t.url));
  const chain = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'NevervoidMigrationCheck/1.0' } });
    if (r.status >= 300 && r.status < 400) {
      chain.push(r.status);
      url = new URL(r.headers.get('location'), url).href;
      continue;
    }
    const body = t.title ? await r.text() : '';
    const finalPath = decodeURI(new URL(url).pathname);
    const problems = [];
    if (r.status !== 200) problems.push(`status ${r.status}`);
    if (finalPath !== t.expect && !(t.expect === '/sitemap.xml' && finalPath === '/sitemap.xml')) problems.push(`landed on ${finalPath}, expected ${t.expect}`);
    if (chain.length !== t.hops) problems.push(`${chain.length} redirects (expected ${t.hops})`);
    if (chain.some((s) => s !== 301)) problems.push(`non-301 redirect ${chain.join('>')}`);
    if (t.title) {
      const title = /<title>([^<]*)<\/title>/.exec(body)?.[1]?.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      if (title !== t.title) problems.push(`title "${title}"`);
    }
    return problems;
  }
  return ['redirect loop'];
}

let fails = 0;
const queue = [...tests];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const t = queue.shift();
      const p = await run(t).catch((e) => [String(e.message)]);
      if (p.length) {
        fails++;
        console.log(`FAIL ${t.url}: ${p.join('; ')}`);
      }
    }
  }),
);
console.log(`${tests.length - fails}/${tests.length} old URLs OK on ${base}`);
process.exit(fails ? 1 : 0);
