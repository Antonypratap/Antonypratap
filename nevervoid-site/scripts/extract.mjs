// Read-only extraction of the live SmugMug site into data/*.json.
//
//   NODE_USE_ENV_PROXY=1 node scripts/extract.mjs [rendered.json]
//
// - Reads the live sitemap (the authoritative list of public URLs).
// - Fetches each page's server HTML (1 request/second) and keeps: title, meta
//   description, canonical, og:image, headings and body copy in order, with
//   inline links preserved so internal linking survives the migration.
// - Optionally merges a rendered crawl (scripts/crawl-rendered.cjs output),
//   which is the only way to see SmugMug's JavaScript-loaded galleries:
//   image URLs, alt text and per-image page URLs (/Gallery/i-XXXX).
// Nothing is written to SmugMug. GET requests only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ORIGIN = 'https://www.nevervoid.com';
const UA = 'Mozilla/5.0 (compatible; NevervoidOwnerSEOAudit/1.0)';
const DATA = path.join(import.meta.dirname, '..', 'data');
const renderedPath = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', copy: '©' };
export const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const text = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Keep only <a href>, <strong>, <b>, <em>, <i>, <br>; everything else becomes text.
function inlineHtml(s) {
  const out = [];
  const re = /<(\/?)(a|strong|b|em|i|br)\b([^>]*)>|<[^>]+>|([^<]+)/gi;
  let m;
  const open = [];
  while ((m = re.exec(s))) {
    if (m[4] !== undefined) {
      out.push(esc(decode(m[4]).replace(/\s+/g, ' ')));
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase().replace(/^b$/, 'strong').replace(/^i$/, 'em');
    if (tag === 'br') {
      out.push('<br>');
      continue;
    }
    if (m[1]) {
      const i = open.lastIndexOf(tag);
      if (i >= 0) {
        open.splice(i, 1);
        out.push(`</${tag}>`);
      }
      continue;
    }
    if (tag === 'a') {
      const href = /href="([^"]*)"/i.exec(m[3])?.[1];
      if (!href) continue;
      let h = decode(href).replace(/^https?:\/\/(www\.)?nevervoid\.com/i, '') || '/';
      if (h.startsWith('/') && h.length > 1) h = h.replace(/\/$/, '');
      out.push(`<a href="${esc(h)}">`);
    } else out.push(`<${tag}>`);
    open.push(tag);
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('').replace(/\s+/g, ' ').trim();
}

const meta = (h, attr, name) => {
  const tag = new RegExp(`<meta[^>]+${attr}="${name}"[^>]*>`, 'i').exec(h)?.[0];
  return tag ? decode(/content="([^"]*)"/i.exec(tag)?.[1] ?? '') : '';
};

export function parsePage(h) {
  const title = decode(/<title>([\s\S]*?)<\/title>/i.exec(h)?.[1]?.trim() ?? '');
  let body = h.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  body = body.slice(body.indexOf('<body'));
  const blocks = [];
  for (const m of body.matchAll(/<(h[1-6]|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = text(m[2]);
    if (!t || /^-+$/.test(t)) continue;
    blocks.push({ tag: m[1].toLowerCase(), text: t, html: inlineHtml(m[2]) });
  }
  return {
    title,
    description: meta(h, 'name', 'description'),
    canonical: /<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i.exec(h)?.[1] ?? '',
    ogImage: meta(h, 'property', 'og:image'),
    ogTitle: meta(h, 'property', 'og:title'),
    blocks,
  };
}

// photos.smugmug.com/<path>/i-ID/0/TOKEN/SIZE/name-SIZE.jpg -> parts
export function parseImage(src) {
  const m = /^(https:\/\/photos\.smugmug\.com\/(?:[^?#]*\/)?i-([A-Za-z0-9]+)\/\d+\/[A-Za-z0-9]+)\/([A-Za-z0-9]+)\/([^/?#]+?)-\3\.(jpe?g|png|gif|webp)$/i.exec(src);
  if (!m) return null;
  return { id: m[2], base: m[1], file: m[4], ext: m[5] };
}

async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
      return { status: r.status, location: r.headers.get('location'), body: Buffer.from(await r.arrayBuffer()) };
    } catch (e) {
      await sleep(2000 * 2 ** i);
    }
  }
  return { status: 0, body: Buffer.alloc(0) };
}

async function main() {
  const idx = (await get(`${ORIGIN}/sitemap-index.xml`)).body.toString();
  const maps = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const urls = [];
  for (const sm of maps) {
    let b = (await get(sm)).body;
    if (sm.endsWith('.gz')) b = zlib.gunzipSync(b);
    for (const u of b.toString().matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = /<loc>([^<]+)<\/loc>/.exec(u[1])[1];
      const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(u[1])?.[1] ?? null;
      urls.push({ path: loc.replace(ORIGIN, '') || '/', lastmod });
    }
  }
  console.log(`sitemap: ${urls.length} URLs`);

  const pages = [];
  for (const [i, u] of urls.entries()) {
    let r = await get(ORIGIN + (u.path === '/' ? '' : u.path));
    // SmugMug answers some folders (e.g. /browse) with a 302 to a trailing-slash URL.
    for (let hop = 0; hop < 3 && r.status >= 300 && r.status < 400 && r.location; hop++) r = await get(new URL(r.location, ORIGIN).href);
    const p = parsePage(r.body.toString('utf8'));
    pages.push({ path: u.path, lastmod: u.lastmod, status: r.status, ...p });
    console.log(i, r.status, u.path, '|', p.title.slice(0, 60));
    await sleep(1000);
  }

  // Boilerplate = a block repeated on >= 25% of pages (footer, menus).
  const freq = new Map();
  for (const p of pages) for (const t of new Set(p.blocks.map((b) => b.text))) freq.set(t, (freq.get(t) ?? 0) + 1);
  const limit = Math.max(3, pages.length * 0.25);
  for (const p of pages) p.blocks = p.blocks.filter((b) => freq.get(b.text) < limit);

  // Merge the rendered crawl: images (with alt), rendered H1s, image-page URLs.
  const images = {};
  if (renderedPath && fs.existsSync(renderedPath)) {
    const R = JSON.parse(fs.readFileSync(renderedPath, 'utf8'));
    const byPath = new Map(Object.entries(R).map(([u, d]) => [u.replace(ORIGIN, '') || '/', d]));
    for (const p of pages) {
      const d = byPath.get(p.path);
      if (!d || d.error) continue;
      p.renderedH1 = d.h1;
      const seen = new Set();
      p.images = [];
      for (const im of d.imgs) {
        const x = parseImage(im.src);
        if (!x || seen.has(x.id)) continue;
        seen.add(x.id);
        const alt = (im.alt ?? '').trim();
        p.images.push(x.id);
        images[x.id] ??= { ...x, alt, pages: [] };
        if (!images[x.id].alt && alt) images[x.id].alt = alt;
        images[x.id].pages.push(p.path);
      }
      p.imagePages = [...new Set(d.links.map((l) => l.replace(/^https?:\/\/www\.nevervoid\.com/, '').split(/[?#]/)[0]).filter((l) => /\/i-[A-Za-z0-9]+$/.test(l)))];
    }
    // Rendered-only internal links not in the sitemap (candidates for redirects).
    const known = new Set(pages.map((p) => p.path.toLowerCase()));
    const extra = new Set();
    for (const d of byPath.values())
      for (const l of d.links ?? []) {
        const m = /^https?:\/\/www\.nevervoid\.com(\/[^?#]*)/.exec(l);
        if (!m) continue;
        const pth = m[1].replace(/\/$/, '') || '/';
        if (!known.has(pth.toLowerCase()) && !/\/i-[A-Za-z0-9]+$/.test(pth)) extra.add(pth);
      }
    fs.writeFileSync(path.join(DATA, 'unlisted-links.json'), JSON.stringify([...extra].sort(), null, 1));
  }

  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'pages.json'), JSON.stringify(pages, null, 1));
  fs.writeFileSync(path.join(DATA, 'images.json'), JSON.stringify(images, null, 1));
  console.log(`wrote ${pages.length} pages, ${Object.keys(images).length} images`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
