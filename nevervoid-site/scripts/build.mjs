// Static build: data/*.json + src/ -> dist/
//   node scripts/build.mjs
// Every URL in data/pages.json (the live SmugMug sitemap) is emitted at the
// exact same path, plus every per-image page (/Gallery/i-XXXX) seen in the
// rendered crawl. Output uses "file" format (Page.html served at /Page), which
// Cloudflare Pages and Netlify serve without a trailing slash, as SmugMug did.
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { SITE, waLink, fullAddress, mapsLink } from '../src/config.js';
import { applyFixes, REMOVED, ALT_OVERRIDES } from '../src/content-fixes.js';
import { shareRow, subscribeForm, pinUrl, PIN_MARK, iconLinks, PIN_ICON, PHONE_ICON as PHONE_ICON_, MAIL_ICON as MAIL_ICON_, bookBtn, layout, esc, img, href, abs, crumbs, breadcrumbLd, ctaBand, imgAbs, imgUrl, ogUrl, waIcon } from '../src/lib.js';
import { home, headshots, corporate, branding, fitness, femaleFitness, clients, christmas, postCards } from '../src/templates/featured.js';
import { resolve as resolveRedirect } from '../src/redirects.js';
import { PAGE_COPY } from '../src/content/page-copy.js';
import { fillPackageTokens } from '../src/packages.js';
import { faqHtml, faqLd } from '../src/lib.js';
import { GROUPS, ARTICLES, LEGAL, KEYWORD_REDIRECTS, LEGACY, CASE_COLLISIONS } from '../src/site-map.js';

const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const images = read('data/images.json');
// Photos self-hosted by scripts/images.mjs; only these are shown on the site.
const media = fs.existsSync(path.join(ROOT, 'data/media.json')) ? read('data/media.json') : {};
for (const [id, m] of Object.entries(media)) if (images[id]) images[id].media = m;
if (media.LPQ9Jzq) SITE.defaultOgImage = media.LPQ9Jzq.og ? `${SITE.origin}/img/${media.LPQ9Jzq.name}-og.jpg` : `${SITE.origin}/img/${media.LPQ9Jzq.name}-${media.LPQ9Jzq.widths.at(-1)}.webp`;
const { pages, log: fixLog } = applyFixes(read('data/pages.json'), images);
let linkRoutes; // set before pages are written
// Versioned stylesheet name: assets are cached for a year, so every CSS
// change must get a new URL or browsers keep showing the old styles.
import crypto from 'node:crypto';
const cssSource = fs.readFileSync(path.join(ROOT, 'public/assets/site.css'));
const cssHash = crypto.createHash('sha256').update(cssSource).digest('hex').slice(0, 10);
SITE.cssHref = `/assets/site.${cssHash}.css`;
const BUILD_DATE = process.env.BUILD_DATE ?? new Date().toISOString().slice(0, 10);

const byPath = new Map(pages.map((p) => [p.path, p]));
const SUFFIX = / - Nevervoid Photography - Bangalore$/;
export const stem = (t) => t.replace(SUFFIX, '').trim();
const short = (t) => stem(t).split(' | ')[0].trim();

// ---------- alt text ----------
const BAD_ALT = /^(untitled photo|screenshot.*|img[_-]?\d+.*|dsc.*|i-[a-z0-9]+|ultimate.*|\d+)$/i;
function humanize(file) {
  const s = file
    .replace(/^i-[A-Za-z0-9]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b(\d+|x\d|copy|final|edit(ed)?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
const clip = (s, n) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n)).replace(/[\s,–-]+$/, '') + '…');
function altFor(im, pagePath) {
  let a = (im.alt ?? '').split(/\n/)[0].trim().replace(/\s+/g, ' ');
  if (!a || BAD_ALT.test(a) || (!/\s/.test(a) && /[-_.]/.test(a))) a = humanize(im.file);
  if (!a || a.split(' ').length < 2) a = `${stem(byPath.get(pagePath)?.title ?? 'Photograph')}: photograph by Nevervoid Photography`;
  return clip(a, 125);
}
for (const [id, im] of Object.entries(images)) {
  im.originalAlt = im.alt;
  // Owner: "female fitness", never "bikini".
  im.alt = (ALT_OVERRIDES[id] ?? altFor(im, im.pages[0])).replace(/fitness bikini/gi, 'female fitness').replace(/bikini fitness/gi, 'female fitness').replace(/bikini/gi, 'female');
}

// ---------- graphics vs photos ----------
// Galleries are for photographs. Graphics (price lists, process charts,
// review cards, logos, mockups, screenshots) only show where they are the
// content. Checked by eye on 4 Nov 2026.
const NEVER_IN_GALLERIES = new Set(['zsWsPFn', 'vVzb6NJ', 'BFfQXs5', 'SW2FwDC']); // price lists, package collage, process graphic
const REVIEW_PAGES = new Set(['/Reviews', '/Testimonials', '/Portrait-headshot-photography-reviews']);
const FRAME_MOCKUPS = new Set(['kDP2mZL', 'mRXnMtG', '7WV2c3D', 'brbbbvc']);
function allowedOn(im, page) {
  if (NEVER_IN_GALLERIES.has(im.id)) return false;
  if (/review|testimonial/i.test(im.file)) return REVIEW_PAGES.has(page);
  if (/logo/i.test(im.file)) return page === '/Clients';
  if (/screenshot/i.test(im.file)) return page === '/Press';
  if (FRAME_MOCKUPS.has(im.id)) return /frame|framing|printing|Framed/i.test(page);
  return true;
}

// ---------- image pages ----------
const imagePageFor = new Map(); // `${galleryPath}|${id}` -> image page path
const imagePages = [];
for (const p of pages) {
  for (const ip of p.imagePages ?? []) {
    const id = ip.split('/i-').pop();
    const gallery = ip.slice(0, ip.lastIndexOf('/i-')) || '/';
    if (!images[id]?.media || !allowedOn(images[id], gallery)) continue; // not shown here: the old URL 301s to its gallery
    imagePageFor.set(`${gallery}|${id}`, ip);
    if (!imagePages.some((x) => x.path === ip)) imagePages.push({ path: ip, id, gallery });
  }
}

// ---------- content helpers handed to templates ----------
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ctx = {
  page: (p) => byPath.get(p),
  image: (id) => (images[id]?.media ? images[id] : undefined),
  imagesOf: (p) => (byPath.get(p)?.images ?? []).map((id) => images[id]).filter((im) => im?.media && allowedOn(im, p)),
  imagePageOf: (gallery, id) => imagePageFor.get(`${gallery}|${id}`),
  // blocks strictly between the block whose text starts with `start` and the one starting with `end`
  blocksAfter(p, start, end) {
    const b = byPath.get(p)?.blocks ?? [];
    const i = b.findIndex((x) => norm(x.text).startsWith(norm(start)));
    if (i < 0) return [];
    const j = end ? b.findIndex((x, k) => k > i && norm(x.text).startsWith(norm(end))) : -1;
    return b.slice(i + 1, j < 0 ? undefined : j);
  },
  // paragraph blocks following a heading until the next heading
  blocksUntilHeading(p, heading) {
    const b = byPath.get(p)?.blocks ?? [];
    const i = b.findIndex((x) => /^h/.test(x.tag) && norm(x.text) === norm(heading));
    if (i < 0) return [];
    const out = [];
    for (const x of b.slice(i + 1)) {
      if (/^h/.test(x.tag)) break;
      out.push(x);
    }
    return out;
  },
  posts: [],
};

// ---------- blog ----------
function parseFront(src) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, md: m[2] };
}
const blogDir = path.join(ROOT, 'src/content/blog');
const posts = fs
  .readdirSync(blogDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => {
    const { fm, md } = parseFront(fillPackageTokens(fs.readFileSync(path.join(blogDir, f), 'utf8'), f));
    return {
      path: `/blog/${f.replace(/\.md$/, '')}`,
      title: fm.title,
      description: fm.description,
      date: fm.date,
      author: fm.author,
      category: fm.category,
      imagePage: '/' + fm.image,
      related: (fm.related ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      html: marked.parse(md),
    };
  })
  .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
ctx.posts = posts;

// ---------- routing tables ----------
const groupOf = new Map();
for (const g of GROUPS) for (const p of g.paths) if (!groupOf.has(p)) groupOf.set(p, g);
const children = (p) => pages.filter((x) => x.path !== p && x.path.startsWith(p + '/') && !x.path.slice(p.length + 1).includes('/'));
const parentOf = (p) => {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : null;
};

function trailFor(p) {
  const t = [];
  const parent = parentOf(p);
  if (parent && byPath.has(parent)) t.push(...trailFor(parent));
  else if (groupOf.has(p) && !ARTICLES.includes(p)) t.push([`/services`, 'Services']);
  else if (ARTICLES.includes(p)) t.push(['/blog', 'Journal']);
  t.push([p, short(byPath.get(p)?.title ?? p)]);
  return t;
}

function describe(p) {
  const d = describeRaw(p);
  if (d.text.length >= 70) return d;
  const pg = byPath.get(p);
  const extra = `${stem(pg.title)} by Nevervoid Photography, a professional photographer in Bangalore since ${SITE.foundingYear}.`;
  return { text: clip(d.text ? `${d.text.replace(/\.?$/, '.')} ${extra}` : extra, 155), source: d.text ? 'extended (was too short)' : d.source };
}
function describeRaw(p) {
  const pg = byPath.get(p);
  const homeDesc = byPath.get('/').description;
  if (pg.description && (pg.description !== homeDesc || p === '/')) return { text: pg.description, source: 'existing' };
  const para = pg.blocks.find((b) => b.tag === 'p' && b.text.length >= 60);
  if (para) return { text: clip(para.text, 155), source: pg.description ? 'rewritten (was sitewide duplicate)' : 'new (was missing)' };
  if (pg.description) return { text: pg.description, source: 'existing' };
  return { text: clip(`${stem(pg.title)} by Nevervoid Photography, a professional photographer in Bangalore since ${SITE.foundingYear}.`, 155), source: 'new (was missing)' };
}

// ---------- generic page ----------
function blocksHtml(blocks, skipText = new Set()) {
  const out = [];
  let list = null;
  // SmugMug pages often style whole paragraphs as headings (h3/h4). Anything
  // longer than a real heading is treated as a paragraph.
  const kept = blocks.filter((b) => !skipText.has(norm(b.text))).map((b) => (/^h/.test(b.tag) && b.text.length > 90 ? { ...b, tag: 'p' } : b));
  // A short heading followed by another heading (or nothing) introduced an
  // image-only section on SmugMug; without its images it would be empty.
  const visible = kept.filter((b, i) => !/^h/.test(b.tag) || (kept[i + 1] && !/^h/.test(kept[i + 1].tag)));
  for (const b of visible) {
    if (b.tag === 'li') {
      if (!list) out.push((list = []));
      list.push(`<li>${b.html}</li>`);
      continue;
    }
    list = null;
    if (/^h[12]$/.test(b.tag)) out.push(`<h2>${b.html}</h2>`);
    else if (/^h/.test(b.tag)) out.push(`<h3>${b.html}</h3>`);
    else if (b.tag === 'blockquote') out.push(`<blockquote>${b.html}</blockquote>`);
    else out.push(`<p>${b.html}</p>`);
  }
  return out.map((x) => (Array.isArray(x) ? `<ul>${x.join('')}</ul>` : x)).join('\n');
}

function galleryHtml(p, ims) {
  return `<div class="gallery">${ims
    .map((im) => `<a href="${href(imagePageFor.get(`${p}|${im.id}`) ?? p)}">${img(im, { sizes: '(max-width: 640px) 100vw, 33vw' })}</a>`)
    .join('')}</div>`;
}

function relatedHtml(p) {
  const g = groupOf.get(p);
  const sib = (g?.paths ?? []).filter((x) => x !== p && byPath.has(x)).slice(0, 10);
  const kids = children(p);
  let html = '';
  if (kids.length)
    html += `<section class="section-tight"><div class="wrap"><h2>In this collection</h2><div class="cards">${kids
      .map((k) => {
        const im = ctx.imagesOf(k.path)[0];
        return `<a class="card" href="${href(k.path)}">${im ? img(im, { sizes: '(max-width: 640px) 100vw, 33vw' }) : ''}<div class="card-body"><h3>${esc(short(k.title))}</h3></div></a>`;
      })
      .join('')}</div></div></section>`;
  if (sib.length)
    html += `<section class="section-tight"><div class="wrap"><h2 style="font-size:1.4rem">More ${esc(g.name.toLowerCase())}</h2><ul class="chips">${sib
      .map((s) => `<li><a href="${href(s)}">${esc(short(byPath.get(s).title))}</a></li>`)
      .join('')}</ul></div></section>`;
  return html;
}

// Which Cal.com booking page fits a page: headshot pages -> headshots, fitness pages -> fitness.
function bookFor(p) {
  const k = groupOf.get(p)?.key;
  if (k === 'headshots') return 'headshots';
  if (k === 'fitness' && /fitness|cult/i.test(p)) return 'fitness';
  return undefined;
}

function topicFor(p) {
  const g = groupOf.get(p);
  return g?.topic ?? 'a photoshoot';
}

function genericPage(p) {
  const pg = byPath.get(p);
  const h1 = stem(pg.title);
  const ims = ctx.imagesOf(p);
  const first = pg.blocks.find((b) => b.tag === 'p' && b.text.length > 30);
  const skip = new Set([norm(h1), norm(pg.title)]);
  if (first) skip.add(norm(first.text));
  const trail = trailFor(p);
  const isArticle = ARTICLES.includes(p);
  const isLegal = LEGAL.includes(p);
  const fitnessy = groupOf.get(p)?.key === 'fitness';
  const prose = blocksHtml(pg.blocks, skip);
  const copy = PAGE_COPY[p];
  const copyHtml = copy
    ? copy.sections
        .map((sec) => `<h2>${esc(sec.h)}</h2>${(sec.p ?? []).map((t) => `<p>${t}</p>`).join('')}${sec.list ? `<ul>${sec.list.map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}`)
        .join('')
    : '';
  const lede = first ? first.html : copy?.lede ?? '';
  const body = `
<section class="page-hero"><div class="wrap">
  ${crumbs(trail)}
  ${isArticle ? '<span class="eyebrow">Journal</span>' : groupOf.get(p) ? `<span class="eyebrow">${esc(groupOf.get(p).name)}</span>` : ''}
  <h1>${esc(h1)}</h1>
  ${lede ? `<p class="lede">${lede}</p>` : ''}
  ${isLegal ? '' : `<div class="actions">${bookFor(p) ? `${bookBtn(bookFor(p), 'btn-primary')}${iconLinks({ topic: topicFor(p), email: false })}` : `<a class="btn btn-primary" href="${waLink(topicFor(p))}" rel="noopener">${waIcon} Enquire on WhatsApp</a>${iconLinks({ topic: topicFor(p), whatsapp: false, email: false })}`}</div>`}
</div></section>
${copyHtml || prose ? `<section class="section-tight"><div class="wrap"><div class="prose">${copyHtml}${prose}</div></div></section>` : ''}
${ims.length ? `<section class="section-tight"><div class="wrap">${galleryHtml(p, ims)}</div></section>` : ''}
${copy?.faqs?.length ? `<section class="section-tight"><div class="wrap narrow"><h2>Questions</h2>${faqHtml(copy.faqs.map((f) => ({ q: f.q, a: `<p>${f.a}</p>` })))}</div></section>` : ''}
${relatedHtml(p)}
${isLegal ? '' : ctaBand({ topic: topicFor(p), number: fitnessy ? SITE.phone : undefined, book: bookFor(p) })}`;
  const desc = describe(p);
  const ld = [breadcrumbLd(trail)];
  if (copy?.faqs?.length) ld.push(faqLd(copy.faqs.map((f) => ({ q: f.q, a: f.a }))));
  if (isArticle)
    ld.push({
      '@type': 'Article',
      headline: h1,
      author: { '@type': 'Person', name: SITE.founder },
      publisher: { '@id': `${SITE.origin}/#business` },
      ...(pg.lastmod ? { dateModified: pg.lastmod } : {}),
      mainEntityOfPage: abs(p),
      ...(ims[0] ? { image: imgAbs(ims[0]) } : {}),
    });
  else if (ims.length)
    ld.push({
      '@type': 'ImageGallery',
      name: h1,
      url: abs(p),
      image: ims.slice(0, 20).map((im) => ({ '@type': 'ImageObject', contentUrl: imgAbs(im), name: im.alt, creator: { '@id': `${SITE.origin}/#business` } })),
    });
  return {
    path: p,
    title: pg.title,
    description: desc.text,
    descSource: desc.source,
    ogImage: ogUrl(ims[0]),
    body,
    ld,
    waTopic: topicFor(p),
    waNumber: fitnessy ? SITE.phone : undefined,
    h1,
    template: isArticle ? 'article' : isLegal ? 'legal' : children(p).length ? 'collection' : 'gallery',
  };
}

// ---------- image page ----------
function imagePage({ path: p, id, gallery }) {
  const im = images[id];
  const g = byPath.get(gallery);
  const gName = short(g.title);
  const ids = (g.images ?? []).filter((x) => imagePageFor.has(`${gallery}|${x}`));
  const i = ids.indexOf(id);
  // Wrap around so the arrows are always there.
  const n = ids.length;
  const prev = n > 1 ? imagePageFor.get(`${gallery}|${ids[(i - 1 + n) % n]}`) : null;
  const next = n > 1 ? imagePageFor.get(`${gallery}|${ids[(i + 1) % n]}`) : null;
  const nextIm = n > 1 ? images[ids[(i + 1) % n]] : null;
  const trail = [...trailFor(gallery), [p, clip(im.alt, 48)]];
  const title = `${clip(im.alt, 60)} | ${gName} - Nevervoid Photography`;
  const description = clip(`${im.alt}. From the ${gName} collection by Nevervoid Photography, Bangalore.`, 155);
  const body = `
<section class="photo-view"><div class="wrap">
  ${crumbs(trail).replace('class="crumbs"', 'class="crumbs" style="color:#bdb4a8"')}
  <div class="photo-stage">
    ${img(im, { eager: true, sizes: '(max-width: 760px) 100vw, 80vw' })}
    ${prev ? `<a class="photo-arrow photo-prev" href="${href(prev)}" rel="prev" aria-label="Previous photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></a>` : ''}
    ${next ? `<a class="photo-arrow photo-next" href="${href(next)}" rel="next" aria-label="Next photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></a>` : ''}
    <span class="photo-count">${i + 1} / ${n}</span>
    <a class="pin-btn photo-pin" href="${esc(pinUrl(abs(p), imgAbs(im), `${im.alt} | ${SITE.name}, Bangalore`))}" target="_blank" rel="noopener">${PIN_MARK}Save<span class="sr-only"> to Pinterest</span></a>
    <a class="photo-close photo-back" href="${href(gallery)}" aria-label="Back to ${esc(gName)}">✕</a>
  </div>
  ${
    n > 1
      ? `<nav class="filmstrip" aria-label="${esc(gName)} photos">${ids
          .map((x) => `<a href="${href(imagePageFor.get(`${gallery}|${x}`))}"${x === id ? ' aria-current="true"' : ''}>${img(images[x], { sizes: '96px' })}</a>`)
          .join('')}</nav>`
      : ''
  }
  <p class="photo-hint">Use ← → keys or swipe to browse · <a href="${href(gallery)}" style="color:#e2b77f">Back to ${esc(gName)}</a></p>
  ${shareRow({ path: p, title: `${im.alt} | ${gName}`, image: imgAbs(im), dark: true, label: 'Share this photo' })}
  ${next ? `<link rel="prefetch" href="${href(next)}">` : ''}${nextIm?.media ? `<link rel="prefetch" href="${imgUrl(nextIm, 1600)}" as="image">` : ''}
</div></section>
<script>(()=>{const q=(s)=>document.querySelector(s),p=q('a[rel=prev]'),n=q('a[rel=next]'),b=q('.photo-back');addEventListener('keydown',(e)=>{if(e.altKey||e.ctrlKey||e.metaKey||e.target.closest('input,textarea,select'))return;if(e.key==='ArrowLeft'&&p)location=p.href;else if(e.key==='ArrowRight'&&n)location=n.href;else if(e.key==='Escape'&&b)location=b.href});let x=null,y=null;const s=q('.photo-stage');s.addEventListener('touchstart',(e)=>{x=e.touches[0].clientX;y=e.touches[0].clientY},{passive:true});s.addEventListener('touchend',(e)=>{if(x===null)return;const dx=e.changedTouches[0].clientX-x,dy=e.changedTouches[0].clientY-y;x=null;if(Math.abs(dx)>50&&Math.abs(dx)>Math.abs(dy)){const t=dx>0?p:n;if(t)location=t.href}},{passive:true});const c=q('.filmstrip [aria-current]');if(c)c.scrollIntoView({block:'nearest',inline:'center'})})()</script>
<section class="section-tight"><div class="wrap narrow"><h1 style="font-size:clamp(1.6rem,3vw,2.2rem)">${esc(im.alt)}</h1><p>From <a href="${href(gallery)}">${esc(gName)}</a> by ${SITE.name}, Bangalore.</p></div></section>
${ctaBand({ topic: topicFor(gallery), number: groupOf.get(gallery)?.key === 'fitness' ? SITE.phone : undefined, book: bookFor(gallery) })}`;
  return {
    path: p,
    title,
    description,
    ogImage: ogUrl(im),
    body,
    ld: [breadcrumbLd(trail), { '@type': 'ImageObject', contentUrl: imgAbs(im), url: abs(p), name: im.alt, creator: { '@id': `${SITE.origin}/#business` }, copyrightHolder: { '@id': `${SITE.origin}/#business` }, creditText: SITE.name }],
    waTopic: topicFor(gallery),
  };
}

// ---------- new pages ----------
function servicesHub() {
  const body = `
<section class="page-hero"><div class="wrap">${crumbs([['/services', 'Services']])}<span class="eyebrow">What we do</span><h1>Photography services in Bangalore</h1><p class="lede">Professional headshots and fitness photography are our specialities. Here is everything else we shoot, edit and print.</p></div></section>
${GROUPS.filter((g) => g.hub)
  .map(
    (g) => `<section class="section-tight" id="${g.key}"><div class="wrap"><div class="section-head" style="margin-bottom:24px"><h2>${esc(g.name)}</h2><p>${esc(g.blurb)}</p></div><div class="cards">${g.paths
      .filter((p) => byPath.has(p))
      .slice(0, g.cards ?? 6)
      .map((p) => {
        const im = ctx.imagesOf(p)[0];
        return `<a class="card" href="${href(p)}">${im ? img(im, { sizes: '(max-width: 640px) 100vw, 33vw' }) : ''}<div class="card-body"><h3>${esc(short(byPath.get(p).title))}</h3><div class="more">View →</div></div></a>`;
      })
      .join('')}</div>${
      g.paths.filter((p) => byPath.has(p)).length > (g.cards ?? 6)
        ? `<ul class="chips" style="margin-top:20px">${g.paths
            .filter((p) => byPath.has(p))
            .slice(g.cards ?? 6)
            .map((p) => `<li><a href="${href(p)}">${esc(short(byPath.get(p).title))}</a></li>`)
            .join('')}</ul>`
        : ''
    }${g.extra ? `<ul class="chips" style="margin-top:12px">${g.extra.map(([u, t]) => `<li><a href="${href(u)}">${esc(t)}</a></li>`).join('')}</ul>` : ''}</div></section>`,
  )
  .join('')}
${ctaBand()}`;
  return { path: '/services', title: 'Photography Services in Bangalore | Headshots, Fitness, Maternity - Nevervoid Photography', description: 'Professional photography services in Bangalore: corporate and LinkedIn headshots, gym and fitness photoshoots, personal branding, maternity, newborn, family, wedding and photo editing.', body, ld: [breadcrumbLd([['/services', 'Services']])], template: 'new' };
}

function browsePage() {
  const listed = new Set(GROUPS.flatMap((g) => g.paths));
  const rest = pages.filter((p) => p.path !== '/' && !listed.has(p.path) && !p.path.slice(1).includes('/'));
  const byGroup = GROUPS.map((g) => [g, g.paths.filter((p) => byPath.has(p))]);
  const body = `
<section class="page-hero"><div class="wrap">${crumbs([['/browse', 'Portfolio']])}<span class="eyebrow">Portfolio</span><h1>Browse the Nevervoid portfolio</h1><p class="lede">Every gallery, from corporate headshots and fitness shoots to weddings, maternity and travel.</p></div></section>
<section class="section-tight"><div class="wrap">${byGroup
    .map(([g, ps]) => `<h2 style="font-size:1.5rem;margin-top:32px">${esc(g.name)}</h2><ul class="chips">${ps.map((p) => `<li><a href="${href(p)}">${esc(short(byPath.get(p).title))}</a></li>`).join('')}</ul>`)
    .join('')}
  ${rest.length ? `<h2 style="font-size:1.5rem;margin-top:32px">Client galleries &amp; more</h2><ul class="chips">${rest.map((p) => `<li><a href="${href(p.path)}">${esc(short(p.title))}</a></li>`).join('')}</ul>` : ''}
</div></section>${ctaBand()}`;
  const pg = byPath.get('/browse');
  return { path: '/browse', title: pg.title, description: describe('/browse').text, descSource: describe('/browse').source, body, ld: [breadcrumbLd([['/browse', 'Portfolio']])], h1: 'Browse the Nevervoid portfolio', template: 'portfolio-index' };
}

function blogIndex() {
  const archive = ARTICLES.filter((p) => byPath.has(p));
  const body = `
<section class="page-hero"><div class="wrap">${crumbs([['/blog', 'Journal']])}<span class="eyebrow">Journal</span><h1>The Nevervoid Journal</h1><p class="lede">Practical guides for headshots, fitness shoots and family portraits, from ${SITE.foundingYear} onwards in Bangalore.</p></div></section>
<section class="section-tight"><div class="wrap">${postCards(ctx, posts)}</div></section>
<section class="section-tight"><div class="wrap narrow"><div class="subscribe-card"><h2>Get new guides by email</h2><p>Photoshoot tips, new work and seasonal offers, now and then. Unsubscribe anytime.</p>${subscribeForm({ source: 'journal' })}</div></div></section>
<section class="section-tight"><div class="wrap"><h2>From the archive</h2><div class="cards">${archive
    .map((p) => {
      const im = ctx.imagesOf(p)[0];
      return `<a class="card" href="${href(p)}">${im ? img(im, { sizes: '(max-width: 640px) 100vw, 33vw' }) : ''}<div class="card-body"><h3>${esc(short(byPath.get(p).title))}</h3><p>${esc(describe(p).text)}</p></div></a>`;
    })
    .join('')}</div></div></section>${ctaBand()}`;
  return { path: '/blog', title: 'Photography Journal: Headshot, Fitness & Portrait Guides | Nevervoid Photography', description: 'Guides from a Bangalore photographer: what to wear for headshots, LinkedIn profile photos, preparing for a fitness photoshoot and more.', body, ld: [breadcrumbLd([['/blog', 'Journal']]), { '@type': 'Blog', name: 'The Nevervoid Journal', url: abs('/blog'), publisher: { '@id': `${SITE.origin}/#business` } }], template: 'new' };
}

function blogPost(post) {
  const ims = ctx.imagesOf(post.imagePage);
  const trail = [['/blog', 'Journal'], [post.path, post.title]];
  const rel = post.related.filter((r) => byPath.has(r));
  const fit = post.category === 'Fitness';
  const body = `
<article>
<section class="page-hero"><div class="wrap narrow">${crumbs(trail)}<span class="eyebrow">${esc(post.category)}</span><h1>${esc(post.title)}</h1><p class="meta">By ${esc(post.author)} · <time datetime="${post.date}">${new Date(post.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</time></p></div></section>
${ims[0] ? `<div class="wrap narrow" style="margin-top:32px">${img(ims[0], { eager: true, sizes: '(max-width: 800px) 100vw, 760px', cls: 'post-cover' })}</div>` : ''}
<section class="section-tight"><div class="wrap narrow"><div class="prose">${post.html}</div></div></section>
</article>
${ims.length > 1 ? `<section class="section-tight"><div class="wrap"><div class="strip">${ims.slice(1, 9).map((im) => `<a href="${href(imagePageFor.get(`${post.imagePage}|${im.id}`) ?? post.imagePage)}">${img(im, { sizes: '260px' })}</a>`).join('')}</div></div></section>` : ''}
<section class="section-tight"><div class="wrap narrow"><div class="subscribe-card"><h2>Get new guides by email</h2><p>Occasional emails with photoshoot tips, new work and seasonal offers. Unsubscribe anytime.</p>${subscribeForm({ source: 'blog-post' })}</div></div></section>
${rel.length ? `<section class="section-tight"><div class="wrap"><h2 style="font-size:1.4rem">Related</h2><ul class="chips">${rel.map((r) => `<li><a href="${href(r)}">${esc(short(byPath.get(r).title))}</a></li>`).join('')}</ul></div></section>` : ''}
${ctaBand({ topic: fit ? 'fitness photography' : 'professional headshots', number: fit ? SITE.phone : undefined, book: fit ? 'fitness' : post.category === 'Headshots' ? 'headshots' : undefined })}`;
  return {
    path: post.path,
    title: `${post.title} | Nevervoid Photography`,
    description: post.description,
    ogType: 'article',
    ogImage: ogUrl(ims[0]),
    body,
    waTopic: fit ? 'fitness photography' : 'professional headshots',
    waNumber: fit ? SITE.phone : undefined,
    ld: [
      breadcrumbLd(trail),
      { '@type': 'BlogPosting', headline: post.title, description: post.description, datePublished: post.date, dateModified: post.date, author: { '@type': 'Person', name: post.author }, publisher: { '@id': `${SITE.origin}/#business` }, mainEntityOfPage: abs(post.path), ...(ims[0] ? { image: imgAbs(ims[0]) } : {}) },
    ],
    template: 'new',
  };
}

function contactPage() {
  const body = `
<section class="page-hero"><div class="wrap">${crumbs([['/contact', 'Contact']])}<span class="eyebrow">Book a session</span><h1>Contact Nevervoid Photography</h1>
<p class="lede">Book a headshot or fitness shoot online in a minute, or message us about anything else: corporate teams, branding, maternity and more.</p>
<div class="actions">${bookBtn('headshots', 'btn-primary', 'Book a headshot')}${bookBtn('fitness', 'btn-primary', 'Book a fitness shoot')}</div></div></section>
<section class="section-tight"><div class="wrap contact-grid">
  <div>
    <h2 style="font-size:1.6rem">Get in touch</h2>
    <ul class="contact-list">
      <li><a href="${waLink('a photoshoot')}" rel="noopener"><span class="icon-btn" aria-hidden="true">${waIcon}</span><span><strong>WhatsApp</strong>${SITE.phoneDisplay}</span></a></li>
      <li><a href="tel:+${SITE.phone}"><span class="icon-btn" aria-hidden="true">${PHONE_ICON_}</span><span><strong>Call</strong>${SITE.phoneDisplay}</span></a></li>
      <li><a href="mailto:${SITE.email}"><span class="icon-btn" aria-hidden="true">${MAIL_ICON_}</span><span><strong>Email</strong>${SITE.email}</span></a></li>
    </ul>
  </div>
  <div>
    <h2 style="font-size:1.6rem">Studio</h2>
    <address class="studio-address"><strong>${esc(SITE.studioName)}</strong><br>${esc(fullAddress())}</address>
    <p><a class="btn btn-ghost btn-sm" href="${mapsLink()}" rel="noopener">${PIN_ICON} Get directions</a></p>
    <p class="meta">On-site sessions anywhere in ${SITE.localityAlt}.</p>
  </div>
</div></section>`;
  return { path: '/contact', title: 'Contact & Booking | Nevervoid Photography - Bangalore', description: `Book a headshot, fitness or portrait photoshoot in Bangalore online, or call or WhatsApp ${SITE.phoneDisplay}. Studio in HRBR Layout, Banaswadi, Bengaluru 560043.`, body, ld: [breadcrumbLd([['/contact', 'Contact']]), { '@type': 'ContactPage', url: abs('/contact'), about: { '@id': `${SITE.origin}/#business` } }], template: 'new' };
}

function subscribedPage() {
  const body = `<section class="page-hero"><div class="wrap narrow"><span class="eyebrow">Newsletter</span><h1>Thank you for subscribing</h1><p class="lede">You will hear from us now and then with new work, photoshoot tips and seasonal offers. If something went wrong, please try again below or WhatsApp us.</p>${subscribeForm({ source: 'subscribed-page' })}<p style="margin-top:24px"><a href="/">Back to the homepage →</a></p></div></section>`;
  return { path: '/subscribed', title: 'Subscribed | Nevervoid Photography', description: 'Thank you for subscribing to Nevervoid Photography: new work, photoshoot tips and seasonal offers from our Bangalore studio.', body, noindex: true, template: 'new', share: false };
}

function notFound() {
  const body = `<section class="page-hero"><div class="wrap"><span class="eyebrow">404</span><h1>This page has moved or no longer exists</h1><p class="lede">Try one of these instead:</p><ul class="chips"><li><a href="/Headshot-photographer-bangalore">Headshot photographer Bangalore</a></li><li><a href="/Fitness-Photography">Fitness photography</a></li><li><a href="/services">All services</a></li><li><a href="/browse">Portfolio</a></li><li><a href="/blog">Journal</a></li><li><a href="/contact">Contact</a></li></ul></div></section>`;
  return { path: '/404', title: 'Page not found | Nevervoid Photography', description: '', body, noindex: true };
}

// ---------- assemble ----------
const FEATURED = { '/': home, '/Headshot-photographer-bangalore': headshots, '/Corporate-photoshoot': corporate, '/Professional-branding-portraits': branding, '/Fitness-Photography': fitness, '/Fitness-bikini-photoshoots': femaleFitness, '/Clients': clients };
const out = [];
for (const p of pages) {
  if (FEATURED[p.path]) out.push({ ...FEATURED[p.path](ctx), template: 'featured', h1: null, descSource: p.path === '/Fitness-Photography' ? 'shortened (was ~600 chars)' : p.path === '/Corporate-photoshoot' || p.path === '/Fitness-bikini-photoshoots' ? 'new (rewritten)' : 'existing' });
  else if (p.path === '/browse') out.push(browsePage());
  else out.push(genericPage(p.path));
}
const newPages = [servicesHub(), { ...christmas(ctx), template: 'new' }, blogIndex(), ...posts.map(blogPost), contactPage(), subscribedPage()];
out.push(...newPages);
const imgOut = imagePages.map(imagePage);

{
  const servedEarly = new Set([...out, ...imgOut].map((p) => p.path));
  const lowerEarly = {};
  for (const p of servedEarly) if (!/\/i-[A-Za-z0-9]+$/.test(p) && !(p.toLowerCase() in lowerEarly)) lowerEarly[p.toLowerCase()] = p;
  Object.assign(lowerEarly, CASE_COLLISIONS);
  const legacyEarly = { ...LEGACY, ...REMOVED };
  for (const [kw, dest] of Object.entries(KEYWORD_REDIRECTS)) legacyEarly[`/keyword/${kw}`] = dest;
  linkRoutes = { pages: servedEarly, legacy: legacyEarly, lower: lowerEarly };
}
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
// Internal links that would hit a redirect (e.g. a broken link in migrated
// copy, or a lowercase/trailing-slash href) are rewritten to the final URL.
const fixLinks = (html) =>
  html.replace(/href="(\/[^"#?]*)([^"]*)"/g, (m, p, rest) => {
    let cur = p;
    try { cur = decodeURI(p); } catch {}
    for (let i = 0; i < 4; i++) {
      const r = resolveRedirect(cur, linkRoutes);
      if (!r) break;
      cur = decodeURI(r.location);
    }
    const out = encodeURI(cur);
    return out === p ? m : `href="${out}${rest}"`;
  });
// Card grids: if every photo in a grid has a similar shape, photos show in
// full (natural aspect). If shapes are mixed (portrait + landscape), the grid
// gets "cards-uniform": one consistent portrait frame, so rows stay aligned.
function uniformCards(html) {
  let out = '';
  let i = 0;
  const open = /<div class="cards([^"]*)">/g;
  let m;
  while ((m = open.exec(html))) {
    let depth = 0;
    let j = m.index;
    const tag = /<\/?div\b/g;
    tag.lastIndex = j;
    let t;
    while ((t = tag.exec(html))) {
      depth += t[0] === '<div' ? 1 : -1;
      if (depth === 0) break;
    }
    const end = t ? t.index : html.length;
    const block = html.slice(m.index, end);
    const ratios = [...block.matchAll(/<img\b[^>]*\swidth="(\d+)" height="(\d+)"/g)].map((r) => +r[1] / +r[2]);
    const mixed = ratios.length > 1 && Math.max(...ratios) / Math.min(...ratios) > 1.15;
    out += html.slice(i, m.index) + (mixed ? `<div class="cards${m[1]} cards-uniform">` : m[0]);
    i = m.index + m[0].length;
    open.lastIndex = i;
  }
  return out + html.slice(i);
}
// "Save" (Pinterest) button on every gallery photo. Plain links, no
// Pinterest script: pins point at the photo's own page and largest file.
const decodeEnt = (t) => t.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function pinButtons(html) {
  return html.replace(/<div class="gallery">([\s\S]*?)<\/div>/g, (m, inner) =>
    `<div class="gallery">${inner.replace(/<a href="([^"]+)">(<img\b[^>]*>)<\/a>/g, (mm, h, imgTag) => {
      const set = /srcset="([^"]+)"/.exec(imgTag)?.[1];
      const big = set ? set.split(',').map((x) => x.trim().split(' ')[0]).at(-1) : /src="([^"]+)"/.exec(imgTag)?.[1];
      const alt = decodeEnt(/alt="([^"]*)"/.exec(imgTag)?.[1] ?? '');
      const url = pinUrl(SITE.origin + h, SITE.origin + big, `${alt} | ${SITE.name}, Bangalore`);
      return `<span class="g-item"><a href="${h}">${imgTag}</a><a class="pin-btn" href="${esc(url)}" target="_blank" rel="noopener">${PIN_MARK}Save<span class="sr-only"> to Pinterest</span></a></span>`;
    })}</div>`,
  );
}
// Share row before the closing call-to-action on content pages.
const NO_SHARE = new Set(['/', '/contact', '/subscribed', '/404', '/Privacy-policy', '/Terms-and-conditions', '/Cancelation-and-refunds']);
function withShare(pg, html) {
  if (NO_SHARE.has(pg.path) || pg.noindex || pg.share === false || /\/i-[A-Za-z0-9]+$/.test(pg.path)) return html;
  const i = html.lastIndexOf('<section class="section-tight"><div class="wrap"><div class="cta-band">');
  if (i < 0) return html;
  const image = (/<meta property="og:image" content="([^"]+)">/.exec(html) ?? [])[1];
  const row = `<section class="section-tight share-section"><div class="wrap">${shareRow({ path: pg.path, title: pg.h1 || pg.title, image: image && decodeEnt(image), label: 'Share this page' })}</div></section>\n`;
  return html.slice(0, i) + row + html.slice(i);
}
const fileFor = (p) => path.join(DIST, p === '/' ? 'index.html' : decodeURI(p).slice(1) + '.html');
const write = (pg) => {
  const f = fileFor(pg.path);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, withShare(pg, pinButtons(uniformCards(fixLinks(layout(pg))))));
};
for (const pg of [...out, ...imgOut, notFound()]) write(pg);

// public/ assets
fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, SITE.cssHref), cssSource);

// ---------- redirects ----------
const served = new Set([...out, ...imgOut].map((p) => p.path));
const lower = {};
for (const p of served) {
  if (/\/i-[A-Za-z0-9]+$/.test(p)) continue; // image IDs are case-sensitive; variants fall back to the gallery
  const k = p.toLowerCase();
  if (!(k in lower)) lower[k] = p;
}
for (const [k, v] of Object.entries(CASE_COLLISIONS)) lower[k] = v; // measured on SmugMug
const legacy = { ...LEGACY, ...REMOVED };
for (const [kw, dest] of Object.entries(KEYWORD_REDIRECTS)) legacy[`/keyword/${kw}`] = dest;
const STATIC = new Set(['/sitemap.xml']);
for (const [k, v] of Object.entries(legacy)) if (!served.has(v) && !STATIC.has(v)) throw new Error(`legacy redirect ${k} -> ${v}: destination not built`);
const routes = { pages: [...served].sort(), legacy, lower };
fs.writeFileSync(path.join(DIST, '_routes-data.json'), JSON.stringify(routes));
fs.mkdirSync(path.join(DIST, '..', 'functions'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'functions', '_middleware.js'),
  `// GENERATED by scripts/build.mjs. Do not edit.\n// Cloudflare Pages middleware: 301s for legacy SmugMug URLs, trailing slashes and\n// case variants, using the same resolver the local verifier tests.\n${fs
    .readFileSync(path.join(ROOT, 'src/redirects.js'), 'utf8')
    .replace('export function resolve', 'function resolve')}\nconst ROUTES = ${JSON.stringify({ legacy, lower })};\nlet PAGES;\nexport async function onRequest(context) {\n  const url = new URL(context.request.url);\n  if (url.hostname === 'nevervoid.com') { url.hostname = 'www.nevervoid.com'; return Response.redirect(url.toString(), 301); }\n  if (!PAGES) PAGES = new Set(await (await context.env.ASSETS.fetch(new URL('/_routes-data.json', url))).json().then((r) => r.pages));\n  const r = resolve(url.pathname, { pages: PAGES, ...ROUTES });\n  if (r) return Response.redirect(new URL(r.location + url.search, url).toString(), r.status);\n  const res = await context.next();\n  // Preview copies on *.pages.dev must never be indexed (duplicate of www.nevervoid.com).\n  if (url.hostname.endsWith('.pages.dev')) {\n    const out = new Response(res.body, res);\n    out.headers.set('X-Robots-Tag', 'noindex, nofollow');\n    // Until www.nevervoid.com points here, its /img/ URLs 404, so share previews\n    // (WhatsApp, Facebook, LinkedIn, X) of preview links use this host's images.\n    if (!(out.headers.get('content-type') || '').includes('text/html') || typeof HTMLRewriter === 'undefined') return out;\n    const swap = { element(el) { const c = el.getAttribute('content'); if (c && c.startsWith('https://www.nevervoid.com/')) el.setAttribute('content', url.origin + c.slice('https://www.nevervoid.com'.length)); } };\n    return new HTMLRewriter().on('meta[property="og:image"]', swap).on('meta[name="twitter:image"]', swap).on('meta[property="og:url"]', swap).transform(out);\n  }\n  return res;\n}\n`,
);

// ---------- sitemap + robots ----------
const lastmodOf = (p) => (byPath.get(p)?.lastmod ? byPath.get(p).lastmod.slice(0, 10) : BUILD_DATE);
const smEntries = out
  .filter((p) => !p.noindex)
  .map((p) => {
    const ims = (byPath.get(p.path)?.images ?? []).map((id) => images[id]).filter((im) => im?.media);
    return `<url><loc>${esc(abs(p.path))}</loc><lastmod>${lastmodOf(p.path)}</lastmod>${ims.map((im) => `<image:image><image:loc>${esc(imgAbs(im))}</image:loc></image:image>`).join('')}</url>`;
  });
fs.writeFileSync(
  path.join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${smEntries.join('\n')}\n</urlset>\n`,
);
// The old robots.txt advertised /sitemap-index.xml; keep that URL working.
fs.writeFileSync(path.join(DIST, 'sitemap-index.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${SITE.origin}/sitemap.xml</loc><lastmod>${BUILD_DATE}</lastmod></sitemap></sitemapindex>\n`);
fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /_routes-data.json\n\nSitemap: ${SITE.origin}/sitemap.xml\n`);

// ---------- migration data for the verifier/report ----------
const manifest = {
  built: BUILD_DATE,
  pages: out.map((p) => ({ path: p.path, title: p.title, description: p.description, descSource: p.descSource ?? 'new', template: p.template, h1: p.h1 ?? null })),
  imagePages: imgOut.length,
};
fs.writeFileSync(path.join(DIST, '_manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`content fixes: ${fixLog.length} (${[...new Set(fixLog.map((l) => l.split(' ')[0]))].length} pages)`);
console.log(`built ${out.length} pages (${newPages.length} new), ${imgOut.length} image pages, ${Object.keys(legacy).length} legacy redirects, sitemap ${smEntries.length} URLs`);
