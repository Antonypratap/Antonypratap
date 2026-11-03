import { SITE, waLink, fullAddress, mapsLink } from './config.js';

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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,500&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${SITE.cssHref ?? '/assets/site.css'}">
<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="logo" href="/">NEVERVOID<span>PHOTOGRAPHY · BANGALORE</span></a>
    <nav class="nav" aria-label="Main">${navHtml}<a class="btn btn-primary btn-sm" href="${wa}" rel="noopener">Book on WhatsApp</a></nav>
    <details class="menu"><summary>Menu</summary><nav class="menu-panel" aria-label="Mobile">${navHtml}<a href="${wa}" rel="noopener">Book on WhatsApp</a></nav></details>
  </div>
</header>
<main id="main">
${body}
</main>
${footer()}
<a class="wa-float" href="${wa}" rel="noopener" aria-label="Chat on WhatsApp">${WA_ICON}</a>
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
        <p><a href="tel:+${SITE.phone}">${SITE.phoneDisplay}</a> · <a href="${waLink('a photoshoot')}" rel="noopener">WhatsApp</a><br><a href="mailto:${SITE.email}">${SITE.email}</a></p>
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
        ['/Fitness-bikini-photoshoots', 'Fitness bikini photoshoots'],
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
    <div class="footer-base">
      <span>© ${new Date().getFullYear()} ${SITE.name}, ${SITE.localityAlt}, India. All images and content are protected by copyright.</span>
      <span><a href="/Privacy-policy">Privacy</a> · <a href="/Terms-and-conditions">Terms</a> · <a href="/Cancelation-and-refunds">Cancellation &amp; refunds</a></span>
    </div>
  </div>
</footer>`;
}

export function ctaBand({ heading = 'Ready when you are.', text = 'Tell us what the photos are for, and we will plan the shoot around it.', topic = 'a photoshoot', number } = {}) {
  return `<section class="section-tight"><div class="wrap"><div class="cta-band">
  <div><h2>${esc(heading)}</h2><p>${esc(text)}</p></div>
  <div class="actions" style="margin:0"><a class="btn btn-light" href="${waLink(topic, number)}" rel="noopener">${WA_ICON} Chat on WhatsApp</a><a class="btn btn-ghost" href="mailto:${SITE.email}">Email us</a></div>
  </div></div></section>`;
}

export function faqHtml(items) {
  return `<div class="faq">${items.map((f) => `<details><summary>${esc(f.q)}</summary><div>${f.a}</div></details>`).join('')}</div>`;
}
export const stripTags = (s) => s.replace(/<[^>]+>/g, '');
export function faqLd(items) {
  return { '@type': 'FAQPage', mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: stripTags(f.a) } })) };
}
