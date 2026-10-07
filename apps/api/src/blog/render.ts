import {
  headingIds,
  inlineText,
  parseInline,
  readingMinutes,
  safeHref,
  type BlogBlock,
} from '@veyra/shared';
import type { BlogAssets } from './assets';
import { articlePath, type ArticleCard, type PublicArticle } from './service';

/**
 * The blog's pages as complete HTML, built on the server: a crawler gets the article, its metadata
 * and its structured data in the first response, with no JavaScript. Every piece of text is
 * escaped here; links are rendered only when `safeHref` accepts them; JSON-LD can never close its
 * script tag. Nothing stored is ever written into the page unescaped.
 */
export interface RenderContext {
  /** The site's public origin (https://veyrafy.com): canonical URLs, Open Graph, sitemap. */
  origin: string;
  assets: BlogAssets;
  /** GA4 measurement id, when configured. */
  ga4: string | null;
  /** The visitor's analytics choice (null: not asked yet). */
  consent: 'granted' | 'denied' | null;
  gscVerification: string | null;
  /** Each image's size (for width/height and srcset). */
  media: Map<string, { width: number; height: number; smallWidth: number | null; alt: string }>;
  now: Date;
}

export const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** JSON for a <script type="application/ld+json"> block (never able to close the tag early). */
const ld = (data: unknown): string =>
  JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(String.fromCharCode(0x2028))
    .join('\\u2028')
    .split(String.fromCharCode(0x2029))
    .join('\\u2029');

const SITE_NAME = 'Veyrafy';
const BLOG_NAME = 'Veyrafy Blog';
const BLOG_DESCRIPTION =
  'Practical guides on verifying supplier invoices before payment: purchase order and goods receipt matching, GST accuracy, duplicate invoices and accounts payable automation.';

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});
const dateText = (iso: string) => DATE.format(new Date(iso));
const timeTag = (iso: string) => `<time datetime="${esc(iso)}">${esc(dateText(iso))}</time>`;

// ── Inline text and blocks ──────────────────────────────────────────────────

function inline(text: string, origin: string): string {
  return parseInline(text)
    .map((n) => {
      switch (n.t) {
        case 'text':
          return esc(n.v);
        case 'strong':
          return `<strong>${esc(n.v)}</strong>`;
        case 'em':
          return `<em>${esc(n.v)}</em>`;
        case 'code':
          return `<code>${esc(n.v)}</code>`;
        case 'link': {
          if (!safeHref(n.href)) return esc(n.v);
          const external = /^https?:/i.test(n.href) && !n.href.startsWith(origin);
          return `<a href="${esc(n.href)}"${external ? ' rel="noopener"' : ''}>${esc(n.v)}</a>`;
        }
      }
    })
    .join('');
}

export const mediaUrl = (id: string, small = false) =>
  `/blog/media/${id}${small ? '-800' : ''}.webp`;

function img(
  ctx: RenderContext,
  id: string,
  alt: string,
  o: { priority?: boolean; sizes?: string } = {},
): string {
  const m = ctx.media.get(id);
  if (!m) return '';
  const srcset = m.smallWidth
    ? ` srcset="${mediaUrl(id, true)} ${m.smallWidth}w, ${mediaUrl(id)} ${m.width}w" sizes="${esc(o.sizes ?? '(min-width: 56rem) 56rem, 100vw')}"`
    : '';
  const loading = o.priority ? ' fetchpriority="high"' : ' loading="lazy"';
  return `<img src="${mediaUrl(id)}"${srcset} width="${m.width}" height="${m.height}" alt="${esc(alt)}"${loading} decoding="async">`;
}

function block(b: BlogBlock, id: string | undefined, ctx: RenderContext): string {
  const t = (s: string) => inline(s, ctx.origin);
  switch (b.type) {
    case 'paragraph':
      return b.text.trim() ? `<p>${t(b.text)}</p>` : '';
    case 'heading':
      return `<h${b.level} id="${esc(id ?? '')}">${t(b.text)}</h${b.level}>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      return `<${tag}>${b.items.map((i) => `<li>${t(i)}</li>`).join('')}</${tag}>`;
    }
    case 'quote':
      return `<blockquote><p>${t(b.text)}</p>${b.cite ? `<footer>${esc(b.cite)}</footer>` : ''}</blockquote>`;
    case 'image': {
      const tag = img(ctx, b.mediaId, b.alt);
      return tag
        ? `<figure>${tag}${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`
        : '';
    }
    case 'table':
      return `<div class="table-wrap"><table>${b.caption ? `<caption>${esc(b.caption)}</caption>` : ''}<thead><tr>${b.header
        .map((h) => `<th scope="col">${t(h)}</th>`)
        .join(
          '',
        )}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${t(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    case 'callout':
      return `<div class="callout${b.tone === 'warning' ? ' warning' : ''}"><p>${t(b.text)}</p></div>`;
    case 'note':
      // Editorial notes are never public.
      return '';
  }
}

// ── Layout ────────────────────────────────────────────────────────────────

interface PageMeta {
  title: string;
  description: string;
  path: string;
  /** Absolute canonical URL (default: this page). */
  canonical?: string | null;
  robots: string;
  ogType: 'website' | 'article';
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: { url: string; width: number; height: number; alt: string } | null;
  twitterCard?: 'summary_large_image' | 'summary';
  jsonLd: unknown[];
  prev?: string | null;
  next?: string | null;
  article?: { publishedAt: string; modifiedAt: string; section: string | null; tags: string[] };
  /** Readers' own pages only: the preview and error pages are never analysed. */
  analytics: boolean;
  /** The current section in the site navigation. */
  nav?: 'blog';
}

function head(m: PageMeta, ctx: RenderContext): string {
  const canonical = m.canonical ?? `${ctx.origin}${m.path}`;
  const og = m.ogImage ?? {
    url: `${ctx.origin}/og-image.png`,
    width: 1200,
    height: 630,
    alt: 'Veyrafy',
  };
  const lines = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(m.title)}</title>`,
    `<meta name="description" content="${esc(m.description)}">`,
    `<meta name="robots" content="${esc(m.robots)}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    m.prev ? `<link rel="prev" href="${esc(ctx.origin + m.prev)}">` : '',
    m.next ? `<link rel="next" href="${esc(ctx.origin + m.next)}">` : '',
    '<meta name="theme-color" content="#f6f1e7">',
    ctx.gscVerification
      ? `<meta name="google-site-verification" content="${esc(ctx.gscVerification)}">`
      : '',
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    '<meta property="og:locale" content="en_IN">',
    `<meta property="og:type" content="${m.ogType}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta property="og:title" content="${esc(m.ogTitle ?? m.title)}">`,
    `<meta property="og:description" content="${esc(m.ogDescription ?? m.description)}">`,
    `<meta property="og:image" content="${esc(og.url)}">`,
    `<meta property="og:image:width" content="${og.width}">`,
    `<meta property="og:image:height" content="${og.height}">`,
    `<meta property="og:image:alt" content="${esc(og.alt)}">`,
    ...(m.article
      ? [
          `<meta property="article:published_time" content="${esc(m.article.publishedAt)}">`,
          `<meta property="article:modified_time" content="${esc(m.article.modifiedAt)}">`,
          m.article.section
            ? `<meta property="article:section" content="${esc(m.article.section)}">`
            : '',
          ...m.article.tags.map((tg) => `<meta property="article:tag" content="${esc(tg)}">`),
        ]
      : []),
    `<meta name="twitter:card" content="${m.twitterCard ?? 'summary_large_image'}">`,
    `<meta name="twitter:title" content="${esc(m.ogTitle ?? m.title)}">`,
    `<meta name="twitter:description" content="${esc(m.ogDescription ?? m.description)}">`,
    `<meta name="twitter:image" content="${esc(og.url)}">`,
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
    `<link rel="alternate" type="application/rss+xml" title="${BLOG_NAME}" href="${ctx.origin}/blog/feed.xml">`,
    ...ctx.assets.preload.map(
      (p) => `<link rel="preload" href="${esc(p)}" as="font" type="font/woff2" crossorigin>`,
    ),
    `<link rel="stylesheet" href="${ctx.assets.css.path}">`,
    ...m.jsonLd.map((d) => `<script type="application/ld+json">${ld(d)}</script>`),
  ];
  return lines.filter(Boolean).join('\n');
}

function siteHeader(nav: PageMeta['nav']): string {
  return `<header class="site"><div class="wrap bar"><a class="brand" href="/" aria-label="Veyrafy home"><img src="/favicon.svg" alt="" width="28" height="28">Veyrafy</a><nav class="nav" aria-label="Primary"><a href="/blog"${nav === 'blog' ? ' aria-current="page"' : ''}>Blog</a><a href="/#how-it-works">How it works</a><a href="/#/login">Client login</a><a class="cta" href="/5-invoice-challenge" data-cta="nav-challenge">5 Invoice Challenge</a></nav></div></header>`;
}

function siteFooter(year: number): string {
  return `<footer class="site-foot"><div class="wrap"><nav aria-label="Footer"><a href="/">Home</a><a href="/blog">Blog</a><a href="/5-invoice-challenge">5 Invoice Challenge</a><a href="/#/request-access">Request access</a><a href="/#/login">Client login</a><a href="/blog/feed.xml">RSS</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav><p>© ${year} Veyrafy. Invoice verification before payment.</p></div></footer>`;
}

function consentBanner(path: string): string {
  return `<aside class="consent" aria-label="Analytics choice"><p>May Veyrafy use Google Analytics to count visits and see which articles help? Nothing is recorded unless you agree.</p><form method="post" action="/blog/consent"><input type="hidden" name="return" value="${esc(path)}"><button class="button" type="submit" name="choice" value="granted">Allow analytics</button><button class="button secondary" type="submit" name="choice" value="denied">No thanks</button></form></aside>`;
}

function page(m: PageMeta, main: string, ctx: RenderContext, banner = ''): string {
  const track = m.analytics && ctx.ga4 && ctx.consent === 'granted';
  const scripts = track
    ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(ctx.ga4 ?? '')}"></script><script src="${ctx.assets.js.path}" data-ga="${esc(ctx.ga4 ?? '')}" data-page="${esc(m.path)}"></script>`
    : '';
  const ask = m.analytics && ctx.ga4 && ctx.consent === null ? consentBanner(m.path) : '';
  return `<!doctype html>\n<html lang="en-IN">\n<head>\n${head(m, ctx)}\n</head>\n<body>\n<a class="skip" href="#main">Skip to content</a>\n${banner}${siteHeader(m.nav)}\n<main id="main">\n${main}\n</main>\n${siteFooter(ctx.now.getUTCFullYear())}\n${ask}${scripts}\n</body>\n</html>\n`;
}

/** Whether the page loads Google's tag (its CSP must then allow Google's hosts). */
export const usesAnalytics = (ctx: RenderContext): boolean =>
  !!ctx.ga4 && ctx.consent === 'granted';

// ── Shared pieces ─────────────────────────────────────────────────────────

const organization = (origin: string) => ({
  '@type': 'Organization',
  name: SITE_NAME,
  url: `${origin}/`,
  logo: { '@type': 'ImageObject', url: `${origin}/favicon.svg` },
});

function breadcrumbs(
  ctx: RenderContext,
  items: { name: string; path: string }[],
): { html: string; data: unknown } {
  const html = `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items
    .map((it, i) =>
      i === items.length - 1
        ? `<li><span aria-current="page">${esc(it.name)}</span></li>`
        : `<li><a href="${esc(it.path)}">${esc(it.name)}</a></li>`,
    )
    .join('')}</ol></nav>`;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: `${ctx.origin}${it.path}`,
    })),
  };
  return { html, data };
}

function cardHtml(c: ArticleCard, ctx: RenderContext, level: 2 | 3 = 2, featured = false): string {
  const image = c.featuredMediaId
    ? img(ctx, c.featuredMediaId, c.featuredAlt ?? '', {
        priority: featured,
        sizes: featured
          ? '(min-width: 56rem) 40rem, 100vw'
          : '(min-width: 64rem) 22rem, (min-width: 40rem) 45vw, 100vw',
      })
    : '';
  const href = articlePath(c.slug);
  const minutes = readingMinutes(c.wordCount);
  return `<article class="${featured ? 'featured' : 'card'}"><a class="thumb" href="${esc(href)}" tabindex="-1" aria-hidden="true">${image || `<div class="ph"><span>${esc(c.category?.name ?? 'Veyrafy')}</span></div>`}</a><div class="card-body">${
    c.category
      ? `<p class="kicker"><a href="/blog/category/${esc(c.category.slug)}">${esc(c.category.name)}</a></p>`
      : ''
  }<h${level}><a href="${esc(href)}">${esc(c.title)}</a></h${level}><p>${esc(c.excerpt)}</p><p class="meta">${
    c.author ? `<span>${esc(c.author.name)}</span>` : ''
  }${c.publishedAt ? `<span>${timeTag(c.publishedAt)}</span>` : ''}<span>${minutes} min read</span></p></div></article>`;
}

function grid(cards: ArticleCard[], ctx: RenderContext, level: 2 | 3 = 2): string {
  return `<ul class="grid">${cards.map((c) => `<li>${cardHtml(c, ctx, level)}</li>`).join('')}</ul>`;
}

function pager(
  base: string,
  pageNo: number,
  pages: number,
  query = '',
): { html: string; prev: string | null; next: string | null } {
  const at = (n: number) => (n <= 1 ? base : `${base}/page/${n}`) + query;
  const prev = pageNo > 1 ? at(pageNo - 1) : null;
  const next = pageNo < pages ? at(pageNo + 1) : null;
  if (pages <= 1) return { html: '', prev, next };
  return {
    html: `<nav class="pager" aria-label="Pages">${prev ? `<a class="button secondary" href="${esc(prev)}" rel="prev">← Newer articles</a>` : '<span></span>'}<span>Page ${pageNo} of ${pages}</span>${
      next
        ? `<a class="button secondary" href="${esc(next)}" rel="next">Older articles →</a>`
        : '<span></span>'
    }</nav>`,
    prev,
    next,
  };
}

function searchForm(q = ''): string {
  return `<form class="search" role="search" method="get" action="/blog/search"><label for="blog-q" class="sr">Search the blog</label><input id="blog-q" type="search" name="q" value="${esc(q)}" placeholder="Search articles" maxlength="120"><button type="submit">Search</button></form>`;
}

function categoryNav(cats: { name: string; slug: string }[], current?: string): string {
  if (!cats.length) return '';
  return `<nav aria-label="Categories"><ul class="cats">${cats
    .map(
      (c) =>
        `<li><a href="/blog/category/${esc(c.slug)}"${c.slug === current ? ' aria-current="page"' : ''}>${esc(c.name)}</a></li>`,
    )
    .join('')}</ul></nav>`;
}

// ── Pages ─────────────────────────────────────────────────────────────────

export function blogIndexPage(
  ctx: RenderContext,
  o: {
    items: ArticleCard[];
    total: number;
    page: number;
    pageSize: number;
    categories: { name: string; slug: string }[];
  },
): string {
  const pages = Math.max(1, Math.ceil(o.total / o.pageSize));
  const p = pager('/blog', o.page, pages);
  const path = o.page > 1 ? `/blog/page/${o.page}` : '/blog';
  const crumbs = breadcrumbs(ctx, [
    { name: 'Home', path: '/' },
    { name: 'Blog', path: '/blog' },
  ]);
  const [first, ...rest] = o.items;
  const featured =
    o.page === 1 && first
      ? `<h2 class="sr">Featured article</h2>${cardHtml(first, ctx, 2, true)}`
      : '';
  const list = o.page === 1 ? rest : o.items;
  const body = o.items.length
    ? `${featured}${list.length ? `<h2 class="section-title">${o.page === 1 ? 'Latest articles' : `Articles, page ${o.page}`}</h2>${grid(list, ctx, 3)}` : ''}`
    : '<div class="empty"><p>The first articles are being written. In the meantime, see how Veyrafy checks invoices on the <a href="/">homepage</a>.</p></div>';
  const main = `<div class="wrap">${crumbs.html}<p class="kicker">Veyrafy Blog</p><h1 class="page-title">Invoice verification, explained</h1><p class="lede">${esc(BLOG_DESCRIPTION)}</p>${searchForm()}${categoryNav(o.categories)}${body}${p.html}${ctaBox('challenge', 'blog-index')}</div>`;
  return page(
    {
      title:
        o.page > 1
          ? `${BLOG_NAME}: Invoice Verification Guides (Page ${o.page})`
          : `${BLOG_NAME}: Invoice Verification and Accounts Payable Guides`,
      description: o.page > 1 ? `${BLOG_DESCRIPTION} Page ${o.page}.` : BLOG_DESCRIPTION,
      path,
      robots: 'index, follow, max-image-preview:large',
      ogType: 'website',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Blog',
          name: BLOG_NAME,
          description: BLOG_DESCRIPTION,
          url: `${ctx.origin}/blog`,
          inLanguage: 'en-IN',
          publisher: organization(ctx.origin),
        },
        crumbs.data,
      ],
      prev: p.prev,
      next: p.next,
      analytics: true,
      nav: 'blog',
    },
    main,
    ctx,
  );
}

export function archivePage(
  ctx: RenderContext,
  o: {
    kind: 'category' | 'tag';
    name: string;
    slug: string;
    description: string;
    items: ArticleCard[];
    total: number;
    page: number;
    pageSize: number;
    categories: { name: string; slug: string }[];
  },
): string {
  const base = `/blog/${o.kind}/${o.slug}`;
  const pages = Math.max(1, Math.ceil(o.total / o.pageSize));
  const p = pager(base, o.page, pages);
  const path = o.page > 1 ? `${base}/page/${o.page}` : base;
  const crumbs = breadcrumbs(ctx, [
    { name: 'Home', path: '/' },
    { name: 'Blog', path: '/blog' },
    { name: o.name, path: base },
  ]);
  const description =
    o.description ||
    (o.kind === 'category'
      ? `Veyrafy articles on ${o.name.toLowerCase()}.`
      : `Veyrafy articles tagged “${o.name}”.`);
  const body = o.items.length
    ? grid(o.items, ctx)
    : '<div class="empty"><p>No articles here yet.</p></div>';
  const main = `<div class="wrap">${crumbs.html}<p class="kicker">${o.kind === 'category' ? 'Category' : 'Tag'}</p><h1 class="page-title">${esc(o.name)}</h1><p class="lede">${esc(description)}</p>${
    o.kind === 'category' ? categoryNav(o.categories, o.slug) : ''
  }${body}${p.html}</div>`;
  return page(
    {
      title: `${o.name}${o.page > 1 ? ` (Page ${o.page})` : ''} | ${BLOG_NAME}`,
      description: o.page > 1 ? `${description} Page ${o.page}.` : description,
      path,
      // Tag archives are thin lists of articles: followed, not indexed (and not in the sitemap).
      robots: o.kind === 'tag' ? 'noindex, follow' : 'index, follow, max-image-preview:large',
      ogType: 'website',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: o.name,
          description,
          url: `${ctx.origin}${path}`,
          isPartOf: { '@type': 'Blog', name: BLOG_NAME, url: `${ctx.origin}/blog` },
        },
        crumbs.data,
      ],
      prev: p.prev,
      next: p.next,
      analytics: true,
      nav: 'blog',
    },
    main,
    ctx,
  );
}

export function searchPage(
  ctx: RenderContext,
  o: { q: string; items: ArticleCard[]; total: number; page: number; pageSize: number },
): string {
  const pages = Math.max(1, Math.ceil(o.total / o.pageSize));
  const query = `?q=${encodeURIComponent(o.q)}`;
  const p = pager('/blog/search', o.page, pages, query);
  const crumbs = breadcrumbs(ctx, [
    { name: 'Home', path: '/' },
    { name: 'Blog', path: '/blog' },
    { name: 'Search', path: '/blog/search' },
  ]);
  const result = !o.q
    ? '<p>Type what you are looking for.</p>'
    : o.items.length
      ? `<p role="status">${o.total} article${o.total === 1 ? '' : 's'} found for “${esc(o.q)}”.</p>${grid(o.items, ctx)}`
      : `<div class="empty" role="status"><p>No articles found for “${esc(o.q)}”. Try other words, or browse the <a href="/blog">latest articles</a>.</p></div>`;
  const main = `<div class="wrap">${crumbs.html}<h1 class="page-title">Search the blog</h1>${searchForm(o.q)}${result}${p.html}</div>`;
  return page(
    {
      title: o.q ? `Search: ${o.q.slice(0, 60)} | ${BLOG_NAME}` : `Search | ${BLOG_NAME}`,
      description: BLOG_DESCRIPTION,
      path: '/blog/search',
      canonical: `${ctx.origin}/blog/search`,
      // Search results are never indexed.
      robots: 'noindex, follow',
      ogType: 'website',
      jsonLd: [crumbs.data],
      analytics: true,
      nav: 'blog',
    },
    main,
    ctx,
  );
}

function ctaBox(cta: 'challenge' | 'demo' | 'none', from: string): string {
  if (cta === 'none') return '';
  if (cta === 'demo')
    return `<aside class="cta-box" aria-label="Talk to Veyrafy"><h2>Check every invoice before you pay</h2><p>Veyrafy checks supplier invoices against your accounting records, purchase orders and goods receipts, and puts every difference in front of your team before payment.</p><a class="button" href="/#/request-access" data-cta="demo-${esc(from)}">Request access</a></aside>`;
  const href = `/5-invoice-challenge?utm_source=blog&utm_medium=cta&utm_campaign=${encodeURIComponent(from)}`;
  return `<aside class="cta-box" aria-label="Try Veyrafy"><h2>Try it on your own invoices</h2><p>Put up to 10 recent supplier invoices through Veyrafy's checks and see which need attention before payment.</p><a class="button" href="${esc(href)}" data-cta="challenge-${esc(from)}">Take the 5 Invoice Challenge</a></aside>`;
}

function toc(blocks: BlogBlock[], ids: Map<number, string>): string {
  const heads = blocks.flatMap((b, i) =>
    b.type === 'heading' && ids.get(i)
      ? [{ level: b.level, text: inlineText(b.text), id: ids.get(i) ?? '' }]
      : [],
  );
  if (heads.filter((h) => h.level === 2).length < 3) return '';
  return `<nav class="toc" aria-labelledby="toc-title"><h2 id="toc-title">On this page</h2><ol>${heads
    .map(
      (h) =>
        `<li${h.level === 3 ? ' class="sub"' : ''}><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`,
    )
    .join('')}</ol></nav>`;
}

export function articlePage(
  ctx: RenderContext,
  a: PublicArticle,
  related: ArticleCard[],
  o: { preview?: boolean } = {},
): string {
  const r = a.row;
  const path = articlePath(r.slug);
  const ids = headingIds(a.blocks);
  const publishedAt = r.publishedAt ?? ctx.now.toISOString();
  const modifiedAt = r.contentUpdatedAt ?? publishedAt;
  const title = r.seoTitle?.trim() || r.title;
  const fullTitle = /veyrafy/i.test(title) ? title : `${title} | ${SITE_NAME}`;
  const description = r.metaDescription?.trim() || r.excerpt;
  const canonical = r.canonicalUrl ?? `${ctx.origin}${path}`;
  const ogId = r.ogImageId ?? r.featuredMediaId;
  const ogMedia = ogId ? ctx.media.get(ogId) : undefined;
  const ogImage =
    ogId && ogMedia
      ? {
          url: `${ctx.origin}${mediaUrl(ogId)}`,
          width: ogMedia.width,
          height: ogMedia.height,
          alt: (r.ogImageId ? ogMedia.alt : r.featuredAlt) || r.title,
        }
      : null;
  const crumbItems = [
    { name: 'Home', path: '/' },
    { name: 'Blog', path: '/blog' },
    ...(a.category ? [{ name: a.category.name, path: `/blog/category/${a.category.slug}` }] : []),
    { name: r.title, path },
  ];
  const crumbs = breadcrumbs(ctx, crumbItems);
  const minutes = readingMinutes(r.wordCount);
  const contents = toc(a.blocks, ids);
  const body = a.blocks.map((b, i) => block(b, ids.get(i), ctx)).join('\n');
  const faq = a.faq.filter((f) => f.q.trim() && f.a.trim());
  const faqHtml = faq.length
    ? `<section class="faq" aria-labelledby="faq"><h2 id="faq">Frequently asked questions</h2>${faq
        .map(
          (f) =>
            `<details><summary>${esc(f.q)}</summary><div><p>${inline(f.a, ctx.origin)}</p></div></details>`,
        )
        .join('')}</section>`
    : '';
  const share = encodeURIComponent(canonical);
  const shareText = encodeURIComponent(r.title);
  const updated =
    r.contentUpdatedAt && r.contentUpdatedAt.slice(0, 10) !== publishedAt.slice(0, 10);
  const authorIsTeam = !a.author || /team|veyrafy/i.test(a.author.name);
  const authorLd = a.author
    ? authorIsTeam
      ? { '@type': 'Organization', name: a.author.name, url: `${ctx.origin}/` }
      : {
          '@type': 'Person',
          name: a.author.name,
          ...(a.author.roleTitle ? { jobTitle: a.author.roleTitle } : {}),
        }
    : organization(ctx.origin);
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: r.title.slice(0, 110),
    description,
    url: `${ctx.origin}${path}`,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    datePublished: publishedAt,
    dateModified: modifiedAt,
    author: authorLd,
    publisher: organization(ctx.origin),
    ...(ogImage ? { image: [ogImage.url] } : {}),
    ...(a.category ? { articleSection: a.category.name } : {}),
    ...(a.tags.length ? { keywords: a.tags.map((x) => x.name).join(', ') } : {}),
    wordCount: r.wordCount,
    inLanguage: 'en-IN',
  };
  const faqLd = faq.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: inlineText(f.a) },
        })),
      }
    : null;
  const hero = r.featuredMediaId
    ? img(ctx, r.featuredMediaId, r.featuredAlt ?? '', { priority: true })
    : '';
  const main = `<div class="wrap"><article><header class="article-head">${crumbs.html}${
    a.category
      ? `<p class="kicker"><a href="/blog/category/${esc(a.category.slug)}">${esc(a.category.name)}</a></p>`
      : ''
  }<h1 class="page-title">${esc(r.title)}</h1>${r.excerpt ? `<p class="lede">${esc(r.excerpt)}</p>` : ''}<p class="byline">${
    a.author
      ? `<span>By <strong>${esc(a.author.name)}</strong>${a.author.roleTitle ? `, ${esc(a.author.roleTitle)}` : ''}</span>`
      : ''
  }<span>Published ${timeTag(publishedAt)}</span>${updated && r.contentUpdatedAt ? `<span>Updated ${timeTag(r.contentUpdatedAt)}</span>` : ''}<span>${minutes} min read</span></p></header>${
    hero ? `<div class="hero-img">${hero}</div>` : ''
  }<div class="layout${contents ? ' has-toc' : ''}">${contents}<div class="prose" data-article>${body}${faqHtml}${
    a.tags.length
      ? `<ul class="tags" aria-label="Tags">${a.tags.map((x) => `<li><a href="/blog/tag/${esc(x.slug)}">${esc(x.name)}</a></li>`).join('')}</ul>`
      : ''
  }<p class="share">Share: <a href="https://www.linkedin.com/sharing/share-offsite/?url=${share}" rel="noopener">LinkedIn</a><a href="https://twitter.com/intent/tweet?url=${share}&amp;text=${shareText}" rel="noopener">X</a><a href="https://wa.me/?text=${shareText}%20${share}" rel="noopener">WhatsApp</a><a href="mailto:?subject=${shareText}&amp;body=${share}">Email</a></p>${
    a.author && (a.author.bio || a.author.roleTitle)
      ? `<div class="author-box"><div><strong>${esc(a.author.name)}</strong>${a.author.bio ? `<p>${esc(a.author.bio)}</p>` : ''}</div></div>`
      : ''
  }${ctaBox(r.cta as 'challenge' | 'demo' | 'none', r.slug)}</div></div></article>${
    related.length
      ? `<section class="related" aria-labelledby="related"><h2 id="related" class="section-title">Related articles</h2>${grid(related, ctx, 3)}</section>`
      : ''
  }</div>`;
  return page(
    {
      title: fullTitle,
      description,
      path,
      canonical,
      robots: o.preview
        ? 'noindex, nofollow'
        : r.noindex
          ? 'noindex, follow'
          : 'index, follow, max-image-preview:large',
      ogType: 'article',
      ogTitle: r.ogTitle ?? title,
      ogDescription: r.ogDescription ?? description,
      ogImage,
      twitterCard: (r.twitterCard as 'summary_large_image' | 'summary') ?? 'summary_large_image',
      jsonLd: o.preview ? [] : [posting, crumbs.data, ...(faqLd ? [faqLd] : [])],
      article: {
        publishedAt,
        modifiedAt,
        section: a.category?.name ?? null,
        tags: a.tags.map((x) => x.name),
      },
      analytics: !o.preview,
      nav: 'blog',
    },
    main,
    ctx,
    o.preview
      ? `<div class="preview-banner" role="status">Preview (${esc(r.status.toLowerCase().replace('_', ' '))}): not public. Search engines are told not to index this page.</div>`
      : '',
  );
}

export function messagePage(ctx: RenderContext, o: { status: 404 | 410; path: string }): string {
  const gone = o.status === 410;
  const main = `<div class="wrap error-page"><p class="kicker">${o.status}</p><h1 class="page-title">${gone ? 'This article has been removed' : 'This page does not exist'}</h1><p class="lede">${
    gone
      ? 'It is no longer published.'
      : 'The address may be mistyped, or the article may have moved.'
  }</p>${searchForm()}<p><a class="button" href="/blog">Go to the blog</a></p></div>`;
  return page(
    {
      title: `${gone ? 'Removed' : 'Page not found'} | ${BLOG_NAME}`,
      description: BLOG_DESCRIPTION,
      path: o.path,
      canonical: `${ctx.origin}/blog`,
      robots: 'noindex, follow',
      ogType: 'website',
      jsonLd: [],
      analytics: false,
      nav: 'blog',
    },
    main,
    ctx,
  );
}

// ── Feeds ─────────────────────────────────────────────────────────────────

const xml = (s: string) => esc(s);

export function sitemapXml(
  origin: string,
  o: {
    articles: { slug: string; lastmod: string }[];
    categories: { slug: string; lastmod: string }[];
    blogLastmod: string | null;
    staticPages: { path: string; lastmod?: string }[];
  },
): string {
  const url = (loc: string, lastmod?: string | null) =>
    `<url><loc>${xml(origin + loc)}</loc>${lastmod ? `<lastmod>${xml(lastmod.slice(0, 10))}</lastmod>` : ''}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
    ...o.staticPages.map((p) => url(p.path, p.lastmod)),
    url('/blog', o.blogLastmod),
    ...o.categories.map((c) => url(`/blog/category/${c.slug}`, c.lastmod)),
    ...o.articles.map((a) => url(articlePath(a.slug), a.lastmod)),
  ].join('\n')}\n</urlset>\n`;
}

export function rssXml(origin: string, items: ArticleCard[], now: Date): string {
  const rfc = (iso: string) => new Date(iso).toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${BLOG_NAME}</title><link>${origin}/blog</link><description>${xml(
    BLOG_DESCRIPTION,
  )}</description><language>en-in</language><lastBuildDate>${rfc(items[0]?.publishedAt || now.toISOString())}</lastBuildDate><atom:link href="${origin}/blog/feed.xml" rel="self" type="application/rss+xml"/>${items
    .map(
      (c) =>
        `<item><title>${xml(c.title)}</title><link>${origin}${articlePath(c.slug)}</link><guid isPermaLink="true">${origin}${articlePath(c.slug)}</guid><pubDate>${rfc(c.publishedAt)}</pubDate><description>${xml(c.excerpt)}</description>${
          c.category ? `<category>${xml(c.category.name)}</category>` : ''
        }</item>`,
    )
    .join('')}</channel></rss>\n`;
}
