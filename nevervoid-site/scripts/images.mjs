// Select, download and optimise the photos the new site uses.
//   NODE_USE_ENV_PROXY=1 node scripts/images.mjs            (behind a proxy)
//   node scripts/images.mjs --dry-run                       (just print the selection)
//
// Selection (about 800 photos): the owner's own gallery order is kept, and
// each page contributes its first N photos:
//   headshot & fitness pages 40 · other service pages 16 · homepage 12
//   client / event / personal galleries 6 (4 if last updated before 2018)
// data/popular.json (optional, a list of SmugMug image IDs, e.g. from
// SmugMug Stats -> Popularity) is always included on top.
//
// Output: public/img/<descriptive-name>-<id>-<width>.webp at 400, 800 and
// 1600 px (longest edge), quality 78, metadata stripped (no EXIF/GPS),
// colour converted to sRGB. data/media.json records name, size and widths.
// Re-running skips photos already processed.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { GROUPS } from '../src/site-map.js';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public/img');
const MEDIA = path.join(ROOT, 'data/media.json');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const pages = read('data/pages.json');
const images = read('data/images.json');
const WIDTHS = [400, 800, 1600];
const DRY = process.argv.includes('--dry-run');

// ---------- selection ----------
const PRIMARY = new Set(['/Headshot-photographer-bangalore', '/Fitness-Photography']);
const SERVICE = new Set(GROUPS.filter((g) => !['personal', 'studio'].includes(g.key)).flatMap((g) => g.paths));
function capFor(p) {
  if (PRIMARY.has(p.path)) return 40;
  if (p.path === '/') return 12;
  if (SERVICE.has(p.path)) return 16;
  const year = +(p.lastmod ?? '2099').slice(0, 4);
  return year < 2018 ? 4 : 6;
}
// Always keep the photos the templates name explicitly (heroes, portraits).
const PINNED = ['Pnw6GqR', 'R2Sg6fk', 'npqHvJ8', 'ctcjcs9', 'LPQ9Jzq'];
const popular = fs.existsSync(path.join(ROOT, 'data/popular.json')) ? read('data/popular.json') : [];

const selected = new Map(); // id -> reason
for (const id of [...PINNED, ...popular]) if (images[id] || id === 'LPQ9Jzq') selected.set(id, 'pinned');
for (const p of pages) for (const id of (p.images ?? []).slice(0, capFor(p))) if (!selected.has(id)) selected.set(id, p.path);

// ---------- naming ----------
const slug = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+[^-]*$/, (m) => (m.length > 12 ? '' : m)) || 'photo';
function nameFor(id) {
  const im = images[id];
  const fromFile = im && !/^i-/.test(im.file) ? slug(im.file) : '';
  const fromAlt = im?.alt ? slug(im.alt) : '';
  const base = fromFile.split('-').length >= 3 ? fromFile : fromAlt || fromFile || 'nevervoid-photography';
  return `${base.replace(/-\d+$/, '')}-${id}`;
}

// ---------- download + convert ----------
// The site's logo/OG image lives outside the galleries.
const EXTRA = { LPQ9Jzq: { base: 'https://photos.smugmug.com/photos/i-LPQ9Jzq/0/MJjrc2RbDnBBvRMRVw6gjgM6S9B7SWCchB6Sx9CZH', file: 'i-LPQ9Jzq', ext: 'png' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function download(im) {
  // Largest first; not every photo was uploaded at every size.
  for (const size of ['X4', 'X3', 'X2', 'XL', 'L']) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${im.base}/${size}/${im.file}-${size}.${im.ext}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NevervoidOwnerMigration/1.0)' } });
        if (r.status === 404 || r.status === 403) break;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { buf: Buffer.from(await r.arrayBuffer()), size };
      } catch {
        await sleep(1500 * 2 ** attempt);
      }
    }
  }
  return null;
}

async function main() {
  console.log(`selected ${selected.size} photos from ${pages.length} pages${popular.length ? ` (+${popular.length} popular)` : ''}`);
  if (DRY) return;
  fs.mkdirSync(OUT, { recursive: true });
  const media = fs.existsSync(MEDIA) ? JSON.parse(fs.readFileSync(MEDIA, 'utf8')) : {};
  // Drop photos no longer selected.
  for (const id of Object.keys(media))
    if (!selected.has(id)) {
      for (const w of media[id].widths) fs.rmSync(path.join(OUT, `${media[id].name}-${w}.webp`), { force: true });
      delete media[id];
    }
  const todo = [...selected.keys()].filter((id) => !media[id] || !media[id].widths.every((w) => fs.existsSync(path.join(OUT, `${media[id].name}-${w}.webp`))));
  let done = 0,
    failed = [];
  let bytesIn = 0,
    bytesOut = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const id = queue.shift();
        const im = images[id] ?? EXTRA[id];
        const got = im && (await download(im));
        if (!got) {
          failed.push(id);
          continue;
        }
        bytesIn += got.buf.length;
        const name = nameFor(id);
        const src = sharp(got.buf, { failOn: 'none' }).rotate();
        const meta = await src.metadata();
        const long = Math.max(meta.width, meta.height);
        const widths = WIDTHS.filter((w) => w <= long);
        if (!widths.length) widths.push(long);
        let w0, h0;
        for (const w of widths) {
          const { data, info } = await sharp(got.buf, { failOn: 'none' })
            .rotate()
            .resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true })
            .toColorspace('srgb')
            .webp({ quality: 78, effort: 5, smartSubsample: true })
            .toBuffer({ resolveWithObject: true });
          fs.writeFileSync(path.join(OUT, `${name}-${w}.webp`), data);
          bytesOut += data.length;
          if (w === widths.at(-1)) [w0, h0] = [info.width, info.height];
        }
        media[id] = { name, width: w0, height: h0, widths, source: got.size };
        done++;
        if (done % 50 === 0) {
          console.log(`  ${done}/${todo.length} processed`);
          fs.writeFileSync(MEDIA, JSON.stringify(media, null, 1));
        }
        await sleep(250);
      }
    }),
  );
  // Social-preview JPEGs (1200 px) for each page's lead photo and the pinned
  // photos: WhatsApp, LinkedIn and Facebook all read JPEG reliably.
  const ogIds = new Set(PINNED);
  for (const p of pages) {
    const first = (p.images ?? []).find((id) => media[id]);
    if (first) ogIds.add(first);
  }
  let og = 0;
  for (const id of ogIds) {
    const m = media[id];
    if (!m) continue;
    const file = path.join(OUT, `${m.name}-og.jpg`);
    if (!fs.existsSync(file)) {
      await sharp(path.join(OUT, `${m.name}-${m.widths.at(-1)}.webp`))
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#141210' })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(file);
      og++;
    }
    m.og = true;
  }
  console.log(`social-preview JPEGs: ${og} new, ${[...ogIds].filter((id) => media[id]).length} total`);
  const sorted = Object.fromEntries(Object.entries(media).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(MEDIA, JSON.stringify(sorted, null, 1));
  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  console.log(`processed ${done} new photos (downloaded ${mb(bytesIn)} -> ${mb(bytesOut)} WebP); ${Object.keys(sorted).length} in library`);
  if (failed.length) console.log(`FAILED (${failed.length}): ${failed.join(', ')}`);
}
main();
