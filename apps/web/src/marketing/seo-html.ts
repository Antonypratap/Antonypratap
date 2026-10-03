import { CONTACT_PHONE } from '../site/host';
import { CRAWLABLE_SUMMARY, FAQ, SEO, SITE_URL } from './seo';

/**
 * The search-engine part of index.html, built from seo.ts at build time (vite.config.ts):
 * meta tags, Open Graph and Twitter cards, structured data (JSON-LD), and the homepage as plain
 * HTML inside #root for crawlers that do not run JavaScript (React replaces it on load).
 */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JSON for a <script type="application/ld+json"> block (never able to close the tag early). */
const ld = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

export function seoHead(): string {
  const image = `${SITE_URL}og-image.png`;
  const organization = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Veyrafy',
    url: SITE_URL,
    logo: `${SITE_URL}favicon.svg`,
    areaServed: 'IN',
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: CONTACT_PHONE.replace(/\s/g, ''),
      contactType: 'sales',
      areaServed: 'IN',
      availableLanguage: ['en'],
    },
  };
  const software = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Veyrafy',
    url: SITE_URL,
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Accounts payable automation',
    operatingSystem: 'Web',
    description: SEO.description,
    audience: {
      '@type': 'BusinessAudience',
      audienceType: 'Finance and accounts payable teams at Indian businesses',
    },
    featureList: CRAWLABLE_SUMMARY.points,
    areaServed: 'IN',
  };
  const website = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Veyrafy',
    url: SITE_URL,
    inLanguage: 'en-IN',
  };
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
  return [
    `<title>${esc(SEO.title)}</title>`,
    `<meta name="description" content="${esc(SEO.description)}" />`,
    `<meta name="keywords" content="${esc(SEO.keywords.join(', '))}" />`,
    `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />`,
    `<link rel="canonical" href="${SITE_URL}" />`,
    `<link rel="alternate" hreflang="en-IN" href="${SITE_URL}" />`,
    `<link rel="alternate" hreflang="x-default" href="${SITE_URL}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Veyrafy" />`,
    `<meta property="og:locale" content="en_IN" />`,
    `<meta property="og:url" content="${SITE_URL}" />`,
    `<meta property="og:title" content="${esc(SEO.shareTitle)}" />`,
    `<meta property="og:description" content="${esc(SEO.shareDescription)}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="Veyrafy: check every invoice against your accounting records before you pay" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(SEO.shareTitle)}" />`,
    `<meta name="twitter:description" content="${esc(SEO.shareDescription)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    ...[organization, software, website, faq].map(
      (d) => `<script type="application/ld+json">${ld(d)}</script>`,
    ),
  ].join('\n    ');
}

/** The homepage in plain, semantic HTML: the same words as the page, replaced by React on load. */
export function crawlableBody(): string {
  const s = CRAWLABLE_SUMMARY;
  return `<main class="seo-fallback">
      <p>${esc(s.kicker)}</p>
      <h1>${esc(s.h1)}</h1>
      <p>${esc(s.lede)}</p>
      <ul>${s.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <h2>Frequently asked questions</h2>
      ${FAQ.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('\n      ')}
    </main>`;
}
