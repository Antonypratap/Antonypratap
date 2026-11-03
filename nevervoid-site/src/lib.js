import { SITE, waLink, fullAddress, mapsLink, BOOKING } from './config.js';

export const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const abs = (p) => SITE.origin + (p === '/' ? '' : encodeURI(p));
export const href = (p) => encodeURI(p);

// Self-hosted WebP renditions made by scripts/images.mjs.
// im.media = { name, width, height, widths: [400, 800, 1600], og }
// `widths` are longest-edge sizes; srcset needs each file's real pixel width.
const realWidth = (m, w) => Math.round((m.width * w) / Math.max(m.width, m.height));
export const imgUrl = (im, w = Infinity) => {
  const m = im.media;
  const pick = m.widths.filter((x) => x <= w).at(-1) ?? m.widths[0];
  return `/img/${m.name}-${pick}.webp`;
};
export const imgAbs = (im) => SITE.origin + imgUrl(im);
// Social previews use a JPEG copy where one exists (some apps ignore WebP).
export const ogUrl = (im) => (im?.media?.og ? `${SITE.origin}/img/${im.media.name}-og.jpg` : im?.media ? imgAbs(im) : undefined);

export function img(im, { sizes = '(max-width: 760px) 100vw, 50vw', cls = '', eager = false, alt } = {}) {
  if (!im?.media) return '';
  const m = im.media;
  const set = m.widths.map((w) => `${imgUrl(im, w)} ${realWidth(m, w)}w`).join(', ');
  return `<img src="${imgUrl(im, 800)}" srcset="${set}" sizes="${sizes}" width="${m.width}" height="${m.height}" alt="${esc(alt ?? im.alt)}"${cls ? ` class="${cls}"` : ''} ${
    eager ? 'fetchpriority="high"' : 'loading="lazy"'
  } decoding="async">`;
}

const WA_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3a.4.4 0 0 0 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.2c0-.1-.2-.2-.5-.3Z"/></svg>';
export const waIcon = WA_ICON;

export const NAV = [
  ['/Headshot-photographer-bangalore', 'Headshots'],
  ['/Corporate-photoshoot', 'Corporate'],
  ['/Fitness-Photography', 'Fitness'],
  ['/services', 'Services'],
  ['/blog', 'Journal'],
  ['/About', 'About'],
  ['/contact', 'Contact'],
];

export function crumbs(trail) {
  if (!trail?.length) return '';
  const items = [['/', 'Home'], ...trail];
  return `<nav class="crumbs" aria-label="Breadcrumb">${items
    .map(([p, n], i) => (i < items.length - 1 ? `<a href="${href(p)}">${esc(n)}</a><span aria-hidden="true">/</span>` : `<span aria-current="page">${esc(n)}</span>`))
    .join('')}</nav>`;
}

export function breadcrumbLd(trail) {
  const items = [['/', 'Home'], ...trail];
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([p, n], i) => ({ '@type': 'ListItem', position: i + 1, name: n, item: abs(p) })),
  };
}

export const businessId = `${SITE.origin}/#business`;
export function businessLd() {
  return {
    '@type': ['LocalBusiness', 'ProfessionalService'],
    '@id': businessId,
    name: SITE.name,
    url: SITE.origin + '/',
    image: SITE.defaultOgImage,
    logo: SITE.defaultOgImage,
    email: SITE.email,
    telephone: '+' + SITE.phone,
    alternateName: SITE.studioName,
    hasMap: mapsLink(),
    founder: { '@type': 'Person', name: SITE.founder },
    foundingDate: String(SITE.foundingYear),
    address: {
      '@type': 'PostalAddress',
      ...(SITE.streetAddress ? { streetAddress: SITE.streetAddress } : {}),
      ...(SITE.postalCode ? { postalCode: SITE.postalCode } : {}),
      addressLocality: SITE.locality,
      addressRegion: SITE.region,
      addressCountry: SITE.country,
    },
    areaServed: { '@type': 'City', name: SITE.locality, alternateName: SITE.localityAlt },
    ...(SITE.sameAs.length ? { sameAs: SITE.sameAs } : {}),
  };
}

export function layout({ path, title, description, ogImage, ogType = 'website', ld = [], body, noindex = false, waTopic = 'a photoshoot', waNumber }) {
  const graph = { '@context': 'https://schema.org', '@graph': [businessLd(), { '@type': 'WebSite', '@id': `${SITE.origin}/#website`, url: SITE.origin + '/', name: SITE.name, publisher: { '@id': businessId } }, ...ld] };
  const navHtml = NAV.map(([p, n]) => `<a href="${href(p)}"${p === path ? ' aria-current="page"' : ''}>${n}</a>`).join('');
  const wa = waLink(waTopic, waNumber);
  return `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<link rel="canonical" href="${abs(path)}">
<meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}">
<meta property="og:site_name" content="${SITE.name}">
<meta property="og:type" content="${ogType}">
<meta property="og:url" content="${abs(path)}">
<meta property="og:title" content="${esc(title)}">
${description ? `<meta property="og:description" content="${esc(description)}">` : ''}
<meta property="og:image" content="${esc(ogImage || SITE.defaultOgImage)}">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
<meta name="geo.region" content="IN-KA">
<meta name="geo.placename" content="${SITE.locality}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/fraunces-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${SITE.cssHref ?? '/assets/site.css'}">
<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="logo" href="/">NEVERVOID<span>PHOTOGRAPHY · BANGALORE</span></a>
    <nav class="nav" aria-label="Main">${navHtml}<a class="btn btn-primary btn-sm" href="/contact">Book a session</a></nav>
    <details class="menu"><summary>Menu</summary><nav class="menu-panel" aria-label="Mobile">${navHtml}<a href="/contact">Book a session</a></nav></details>
  </div>
</header>
<main id="main">
${body}
</main>
${footer()}
<a class="wa-float" href="${wa}" rel="noopener" aria-label="Chat on WhatsApp">${WA_ICON}</a>
<script>(()=>{const d=document;if(navigator.share)d.documentElement.classList.add('can-share');d.addEventListener('click',async(e)=>{const n=e.target.closest('[data-share-native]');if(n){e.preventDefault();try{await navigator.share({title:n.dataset.title,url:n.dataset.url})}catch(_){}return}const c=e.target.closest('[data-copy]');if(c){e.preventDefault();try{await navigator.clipboard.writeText(c.dataset.copy);c.classList.add('copied');c.title='Link copied';setTimeout(()=>{c.classList.remove('copied');c.title='Copy link'},1800)}catch(_){}}});d.addEventListener('submit',async(e)=>{const f=e.target.closest('form[data-subscribe]');if(!f)return;e.preventDefault();const m=f.querySelector('.sub-msg');m.textContent='Subscribing…';try{const r=await fetch(f.action,{method:'POST',body:new FormData(f),headers:{accept:'application/json'}});const j=await r.json();m.textContent=j.message;if(j.ok)f.reset()}catch(_){m.textContent='Something went wrong. Please try again or WhatsApp us.'}})})()</script>
</body>
</html>
`;
}

function footer() {
  const col = (h, links) => `<div><h2>${h}</h2><ul>${links.map(([p, n]) => `<li><a href="${href(p)}">${esc(n)}</a></li>`).join('')}</ul></div>`;
  return `<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        <a class="logo" href="/" style="color:#f3eee7">NEVERVOID<span>PHOTOGRAPHY · BANGALORE</span></a>
        <p style="margin-top:18px;max-width:34ch">Professional photography in Bangalore since ${SITE.foundingYear}: headshots, fitness, personal branding, maternity and family portraits.</p>
        ${iconLinks({ map: true, cls: 'on-dark' })}
        <p class="social-row">${SITE.social
          .map(([n, u]) => `<a class="social-link" href="${u}" rel="noopener me" aria-label="${esc(n)}" title="${esc(n)}">${n.startsWith('Instagram') ? IG_ICON : n === 'Facebook' ? '<span class="brand-mark" data-l="f" aria-hidden="true"></span>' : '<span class="brand-mark" data-l="X" aria-hidden="true"></span>'}</a>`)
          .join('')}${SITE.googleBusiness ? `<a class="review-link" href="${SITE.googleBusiness}" rel="noopener">★ Review us on Google</a>` : ''}</p>
        <address style="font-style:normal;max-width:36ch"><a href="${mapsLink()}" rel="noopener">${esc(SITE.studioName)}<br>${esc(fullAddress())}</a></address>
      </div>
      ${col('Headshots', [
        ['/Headshot-photographer-bangalore', 'Headshot photographer Bangalore'],
        ['/Professional-studio-headshots', 'Studio headshots'],
        ['/Headshot-linkedIn-photography', 'LinkedIn headshots'],
        ['/Professional-branding-portraits', 'Personal branding'],
      ])}
      ${col('Corporate', [
        ['/Corporate-photoshoot', 'Corporate photoshoot'],
        ['/Innosolv-Headshots', 'Team headshots'],
        ['/Corporate-event-photography-innosolv', 'Corporate events'],
        ['/Office-spaces', 'Office spaces'],
      ])}
      ${col('Fitness', [
        ['/Fitness-Photography', 'Gym & fitness photoshoot'],
        ['/Fitness-bikini-photoshoots', 'Female fitness photoshoots'],
        ['/Dance-photographer-bangalore', 'Dance photography'],
        ['/Modelling-portfolio-photography', 'Modelling portfolios'],
      ])}
      ${col('Studio', [
        ['/About', 'About Nevervoid'],
        ['/Reviews', 'Reviews'],
        ['/blog', 'Journal'],
        ['/services', 'All services'],
        ['/contact', 'Contact & booking'],
      ])}
    </div>
    <div class="footer-subscribe">
      <div><h2>Photoshoot tips &amp; new work</h2><p>Occasional emails with new work, photoshoot tips and seasonal offers. Unsubscribe anytime. See our <a href="/Privacy-policy">privacy policy</a>.</p></div>
      ${subscribeForm({ source: 'footer', dark: true })}
    </div>
    <div class="footer-base">
      <span>© ${new Date().getFullYear()} ${SITE.name}, ${SITE.localityAlt}, India. All images and content are protected by copyright.</span>
      <span><a href="/Privacy-policy">Privacy</a> · <a href="/Terms-and-conditions">Terms</a> · <a href="/Cancelation-and-refunds">Cancellation &amp; refunds</a></span>
    </div>
  </div>
</footer>`;
}

export const CAL_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h2M14 14h2M8 17h2"/></svg>';
const ICON = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const PHONE_ICON = ICON('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/>');
export const MAIL_ICON = ICON('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>');
export const PIN_ICON = ICON('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>');
// Compact round icon buttons for secondary contact channels.
export const IG_ICON = ICON('<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/>');
export function iconLinks({ topic = 'a photoshoot', number, whatsapp = true, phone = true, email = true, map = false, cls = '' } = {}) {
  const b = (href, label, icon, ext) => `<a class="icon-btn" href="${href}"${ext ? ' rel="noopener"' : ''} aria-label="${label}" title="${label}">${icon}</a>`;
  return `<span class="icon-links${cls ? ' ' + cls : ''}">${whatsapp ? b(waLink(topic, number), 'Chat on WhatsApp', WA_ICON, true) : ''}${phone ? b(`tel:+${SITE.phone}`, `Call ${SITE.phoneDisplay}`, PHONE_ICON) : ''}${email ? b(`mailto:${SITE.email}`, `Email ${SITE.email}`, MAIL_ICON) : ''}${map ? b(mapsLink(), 'Directions to the studio', PIN_ICON, true) : ''}</span>`;
}
// "Book online" button for a Cal.com booking page: kind = 'headshots' | 'fitness'.
export const bookBtn = (kind, cls = 'btn-light', label = 'Book online') =>
  BOOKING[kind] ? `<a class="btn ${cls}" href="${BOOKING[kind]}" rel="noopener">${CAL_ICON} ${label}</a>` : '';
export const reserveAction = (kind) => (BOOKING[kind] ? { potentialAction: { '@type': 'ReserveAction', target: { '@type': 'EntryPoint', urlTemplate: BOOKING[kind], actionPlatform: ['https://schema.org/DesktopWebPlatform', 'https://schema.org/MobileWebPlatform'] } } } : {});

export function ctaBand({ heading = 'Ready when you are.', text = 'Tell us what the photos are for, and we will plan the shoot around it.', topic = 'a photoshoot', number, book } = {}) {
  const primary = book ? bookBtn(book) : `<a class="btn btn-light" href="${waLink(topic, number)}" rel="noopener">${WA_ICON} Chat on WhatsApp</a>`;
  return `<section class="section-tight"><div class="wrap"><div class="cta-band">
  <div><h2>${esc(heading)}</h2><p>${esc(text)}</p></div>
  <div class="actions" style="margin:0">${primary}${iconLinks({ topic, number, whatsapp: !!book, cls: 'on-dark' })}</div>
  </div></div></section>`;
}

// ---------- sharing ----------
export const SHARE_ICON = ICON('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>');
export const LINK_ICON = ICON('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>');
// Letter marks are drawn with CSS (data-l) so they are not read as text.
const brand = (letters, cls) => `<span class="brand-mark ${cls}" data-l="${letters}" aria-hidden="true"></span>`;
export const pinUrl = (pageAbs, mediaAbs, description) =>
  `https://www.pinterest.com/pin/create/button/?url=${encodeURIComponent(pageAbs)}&media=${encodeURIComponent(mediaAbs)}&description=${encodeURIComponent(description)}`;
export const PIN_MARK = `<svg class="pin-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.8V5h6v5.8l2 2.2v2H7v-2Z"/><path d="M8 5h8"/></svg>`;
// A share row: native share sheet (phones), WhatsApp, Facebook, LinkedIn, X,
// Pinterest (when there is an image), email and copy-link.
export function shareRow({ path, title, image, dark = false, label = 'Share' }) {
  const url = abs(path);
  const t = `${title}`;
  const b = (href, name, inner, ext = true) => `<a class="share-btn" href="${esc(href)}"${ext ? ' target="_blank" rel="noopener"' : ''} aria-label="${name}" title="${name}">${inner}</a>`;
  return `<div class="share${dark ? ' on-dark' : ''}"><span class="share-label">${esc(label)}</span>
  <a class="share-btn share-native" href="#" data-share-native data-url="${esc(url)}" data-title="${esc(t)}" aria-label="Share" title="Share">${SHARE_ICON}</a>
  ${b(`https://wa.me/?text=${encodeURIComponent(`${t} ${url}`)}`, 'Share on WhatsApp', WA_ICON)}
  ${b(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, 'Share on Facebook', brand('f', 'facebook'))}
  ${b(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`, 'Share on LinkedIn', brand('in', 'linkedin'))}
  ${b(`https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(t)}`, 'Share on X', brand('X', 'x'))}
  ${image ? b(pinUrl(url, image, t), 'Save to Pinterest', PIN_MARK) : ''}
  ${b(`mailto:?subject=${encodeURIComponent(t)}&body=${encodeURIComponent(url)}`, 'Share by email', MAIL_ICON, false)}
  <a class="share-btn" href="${esc(url)}" data-copy="${esc(url)}" aria-label="Copy link" title="Copy link">${LINK_ICON}</a>
</div>`;
}

// ---------- subscribe ----------
// Posts to functions/api/subscribe.js (Cloudflare KV). Works without
// JavaScript (redirects to /subscribed); with JS it answers inline.
export function subscribeForm({ source = 'footer', dark = false } = {}) {
  const id = `sub-${source}`;
  return `<form class="subscribe${dark ? ' on-dark' : ''}" action="/api/subscribe" method="post" data-subscribe>
  <label class="sr-only" for="${id}">Email address</label>
  <input id="${id}" type="email" name="email" required autocomplete="email" placeholder="Your email address">
  <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
  <input type="hidden" name="source" value="${esc(source)}">
  <button class="btn ${dark ? 'btn-light' : 'btn-primary'}" type="submit">Subscribe</button>
  <p class="sub-msg" role="status" aria-live="polite"></p>
</form>`;
}

export function faqHtml(items) {
  return `<div class="faq">${items.map((f) => `<details><summary>${esc(f.q)}</summary><div>${f.a}</div></details>`).join('')}</div>`;
}
export const stripTags = (s) => s.replace(/<[^>]+>/g, '');
export function faqLd(items) {
  return { '@type': 'FAQPage', mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: stripTags(f.a) } })) };
}
