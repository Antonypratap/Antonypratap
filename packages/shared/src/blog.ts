/**
 * The Veyrafy blog (veyrafy.com/blog): its content model, lifecycle and editorial checks, shared by
 * the server (which enforces them) and the publishing studio (which shows them while writing).
 *
 * An article's body is a list of typed blocks, never HTML: the server renders every block itself,
 * escaping all text, so nothing stored can inject markup or script (stored XSS has no way in).
 * Text inside a block may carry a small inline markup: **bold**, *italic*, `code` and
 * [link text](/blog/some-article). Nothing else is interpreted.
 */

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * DRAFT: being written (never public). IN_REVIEW: ready for a second reader (never public).
 * SCHEDULED: approved, public from `publishedAt` on (never before). PUBLISHED: public.
 * ARCHIVED: withdrawn (never public; its address answers 410 Gone if it was ever published).
 */
export const BLOG_STATUSES = ['DRAFT', 'IN_REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];

/** The moves an editor may make. Publishing and scheduling also pass the publication checks. */
export const BLOG_TRANSITIONS: Readonly<Record<BlogStatus, readonly BlogStatus[]>> = {
  DRAFT: ['IN_REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'],
  IN_REVIEW: ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'],
  SCHEDULED: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

export const canMoveBlog = (from: BlogStatus, to: BlogStatus): boolean =>
  BLOG_TRANSITIONS[from].includes(to);

/** Publishing events, each recorded with who did it and when. */
export const BLOG_EVENTS = [
  'article.created',
  'article.updated',
  'article.duplicated',
  'article.status',
  'article.slug_changed',
  'article.restored',
  'article.deleted',
  'media.uploaded',
  'media.deleted',
  'taxonomy.changed',
  'author.changed',
  'redirect.changed',
] as const;
export type BlogEvent = (typeof BLOG_EVENTS)[number];

/** What a reader is invited to do after an article (only what exists today). */
export const BLOG_CTAS = ['challenge', 'demo', 'none'] as const;
export type BlogCta = (typeof BLOG_CTAS)[number];

export const TWITTER_CARDS = ['summary_large_image', 'summary'] as const;
export type TwitterCard = (typeof TWITTER_CARDS)[number];

// ── Blocks ───────────────────────────────────────────────────────────────────

export type BlogBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string; cite?: string | undefined }
  | { type: 'image'; mediaId: string; alt: string; caption?: string | undefined }
  | { type: 'table'; caption?: string | undefined; header: string[]; rows: string[][] }
  | { type: 'callout'; tone: 'info' | 'tip' | 'warning'; text: string }
  /** Editorial note (outline, fact to check): never shown publicly; an article with one cannot be published. */
  | { type: 'note'; text: string };

export interface BlogFaq {
  q: string;
  a: string;
}

// ── Slugs ────────────────────────────────────────────────────────────────────

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 80;
/** Path segments the blog's own pages use: never an article, category or tag slug. */
export const RESERVED_SLUGS = new Set([
  'page',
  'category',
  'tag',
  'search',
  'preview',
  'feed',
  'media',
  'assets',
  'author',
  'admin',
  'consent',
]);

/** A slug from any text: lower case, ASCII letters and digits, single hyphens. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

export function slugProblem(slug: string): string | null {
  if (!slug) return 'Enter a URL slug.';
  if (slug.length > SLUG_MAX) return `Keep the slug to ${SLUG_MAX} characters.`;
  if (!SLUG_PATTERN.test(slug))
    return 'Use lower-case letters, digits and single hyphens only (for example how-to-verify-an-invoice).';
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved for the blog's own pages.`;
  return null;
}

// ── Inline markup ────────────────────────────────────────────────────────────

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string };

const INLINE =
  /\[([^\]\n]{1,300})\]\(([^)\s]{1,500})\)|\*\*([^*\n]{1,500})\*\*|\*([^*\n]{1,500})\*|`([^`\n]{1,300})`/g;

/** Inline markup to nodes. Unmatched markers stay plain text; nothing nests. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index;
    if (i > at) out.push({ t: 'text', v: text.slice(at, i) });
    if (m[1] !== undefined && m[2] !== undefined) out.push({ t: 'link', v: m[1], href: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'strong', v: m[3] });
    else if (m[4] !== undefined) out.push({ t: 'em', v: m[4] });
    else if (m[5] !== undefined) out.push({ t: 'code', v: m[5] });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ t: 'text', v: text.slice(at) });
  return out;
}

/** Inline markup to plain text (search, descriptions, word counts). */
export const inlineText = (text: string): string =>
  parseInline(text)
    .map((n) => n.v)
    .join('');

/**
 * A link target the blog will render: a page on this site ("/blog/x", "/#faq"), an anchor
 * ("#section"), https/http, or mailto. Anything else (javascript:, data:, "//host") is refused.
 */
export function safeHref(href: string): boolean {
  if (/^\/(?!\/)[^\s<>"'\\]*$/.test(href)) return true;
  if (/^#[A-Za-z0-9_-]{1,80}$/.test(href)) return true;
  if (/^mailto:[^\s<>"'\\]+$/i.test(href)) return true;
  try {
    const u = new URL(href);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !/[\s<>"'\\]/.test(href);
  } catch {
    return false;
  }
}

/** The site's own address, for telling internal from external links. */
export const BLOG_SITE_ORIGIN = 'https://veyrafy.com';

/** A link to a page on veyrafy.com, as its path ("/blog/x"); null for other sites. */
export function internalPath(href: string): string | null {
  if (href.startsWith('/') && !href.startsWith('//'))
    return href.split('#')[0]?.split('?')[0] ?? null;
  try {
    const u = new URL(href);
    if (u.origin === BLOG_SITE_ORIGIN || u.origin === 'https://www.veyrafy.com') return u.pathname;
  } catch {
    /* not a URL */
  }
  return null;
}

// ── Reading helpers ──────────────────────────────────────────────────────────

/** Every piece of public text in a block (notes are never public). */
export function blockText(b: BlogBlock): string[] {
  switch (b.type) {
    case 'paragraph':
    case 'heading':
    case 'callout':
      return [inlineText(b.text)];
    case 'quote':
      return [inlineText(b.text), b.cite ?? ''];
    case 'list':
      return b.items.map(inlineText);
    case 'image':
      return [b.caption ?? ''];
    case 'table':
      return [b.caption ?? '', ...b.header, ...b.rows.flat()].map(inlineText);
    case 'note':
      return [];
  }
}

export function articleText(blocks: readonly BlogBlock[], faq: readonly BlogFaq[] = []): string {
  return [...blocks.flatMap(blockText), ...faq.flatMap((f) => [f.q, inlineText(f.a)])]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const wordCount = (text: string): number =>
  text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

/** Minutes to read at 220 words a minute (never less than one). */
export const readingMinutes = (words: number): number => Math.max(1, Math.round(words / 220));

/** Each heading's anchor id (unique within the article). */
export function headingIds(blocks: readonly BlogBlock[]): Map<number, string> {
  const ids = new Map<number, string>();
  const used = new Set<string>();
  blocks.forEach((b, i) => {
    if (b.type !== 'heading') return;
    const base = slugify(inlineText(b.text)) || 'section';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    ids.set(i, id);
  });
  return ids;
}

/** Every link in the article (body and FAQ answers). */
export function articleLinks(blocks: readonly BlogBlock[], faq: readonly BlogFaq[] = []): string[] {
  const texts = blocks.flatMap((b) => {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
      case 'callout':
      case 'quote':
        return [b.text];
      case 'list':
        return b.items;
      case 'table':
        return [...b.header, ...b.rows.flat()];
      default:
        return [];
    }
  });
  return [...texts, ...faq.map((f) => f.a)].flatMap((t) =>
    parseInline(t).flatMap((n) => (n.t === 'link' ? [n.href] : [])),
  );
}

// ── Editorial checks ─────────────────────────────────────────────────────────

export interface BlogCheckInput {
  title: string;
  slug: string;
  excerpt: string;
  blocks: readonly BlogBlock[];
  faq: readonly BlogFaq[];
  authorId: string | null;
  categoryId: string | null;
  seoTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  focusKeyword: string | null;
  featuredMediaId: string | null;
  featuredAlt: string | null;
  ogImageId: string | null;
}

export interface BlogIssue {
  /** error: publication is refused until fixed. warning / info: guidance only. */
  level: 'error' | 'warning' | 'info';
  field: string;
  message: string;
}

/**
 * The checks shown while writing and enforced when publishing (errors only). They are editorial
 * guidance, not a ranking prediction: no score is computed. `knownPaths`: public pages of the site
 * (for broken internal links); omitted, internal links are not checked.
 */
export function blogChecks(a: BlogCheckInput, knownPaths?: ReadonlySet<string>): BlogIssue[] {
  const issues: BlogIssue[] = [];
  const err = (field: string, message: string) => issues.push({ level: 'error', field, message });
  const warn = (field: string, message: string) =>
    issues.push({ level: 'warning', field, message });
  const info = (field: string, message: string) => issues.push({ level: 'info', field, message });

  const title = a.title.trim();
  if (!title) err('title', 'Add a title.');
  const slugIssue = slugProblem(a.slug);
  if (slugIssue) err('slug', slugIssue);
  if (!a.excerpt.trim()) err('excerpt', 'Add an excerpt: it is shown on the blog and in previews.');
  if (!a.authorId) err('authorId', 'Choose an author.');
  if (!a.categoryId) err('categoryId', 'Choose a category.');

  const paragraphs = a.blocks.filter((b) => b.type === 'paragraph' && b.text.trim()).length;
  if (paragraphs === 0) err('blocks', 'Write the article: it has no paragraph yet.');
  if (a.blocks.some((b) => b.type === 'note'))
    err('blocks', 'Remove every editorial note (outline, facts to check) before publishing.');
  a.blocks.forEach((b, i) => {
    if (b.type === 'image' && !b.alt.trim())
      err(`blocks.${i}`, 'Describe every image in its alt text.');
    if (b.type === 'heading' && !b.text.trim()) err(`blocks.${i}`, 'A heading is empty.');
    if (b.type === 'table' && (b.header.length === 0 || b.rows.length === 0))
      err(`blocks.${i}`, 'A table needs a header row and at least one row.');
  });
  a.faq.forEach((f, i) => {
    if (!f.q.trim() || !f.a.trim()) err(`faq.${i}`, 'Each FAQ needs a question and an answer.');
  });
  if (a.featuredMediaId && !a.featuredAlt?.trim())
    err('featuredAlt', 'Describe the featured image in its alt text.');

  const links = articleLinks(a.blocks, a.faq);
  for (const href of links)
    if (!safeHref(href)) err('blocks', `This link is not allowed: ${href.slice(0, 80)}`);
  if (a.canonicalUrl && !/^https:\/\/[^\s]+$/.test(a.canonicalUrl))
    err('canonicalUrl', 'A canonical URL must be a full https:// address.');

  // Guidance (never blocks publication).
  const seoTitle = (a.seoTitle?.trim() || title).trim();
  if (seoTitle.length > 60)
    warn(
      'seoTitle',
      `The search title is ${seoTitle.length} characters; results usually show about 60.`,
    );
  else if (seoTitle && seoTitle.length < 25)
    warn('seoTitle', 'The search title is short; say what the article helps the reader do.');
  const meta = a.metaDescription?.trim() ?? '';
  if (!meta) warn('metaDescription', 'No meta description: the excerpt is used instead.');
  else if (meta.length > 160)
    warn(
      'metaDescription',
      `The meta description is ${meta.length} characters; results usually show about 155.`,
    );
  else if (meta.length < 70)
    warn('metaDescription', 'The meta description is short; 120–155 characters is typical.');
  if (!a.featuredMediaId)
    warn('featuredMediaId', 'No featured image: previews will use the site image.');
  const headings = a.blocks.filter((b) => b.type === 'heading');
  const words = wordCount(articleText(a.blocks, a.faq));
  if (headings.length === 0 && words > 300)
    warn(
      'blocks',
      'No section headings: add H2 headings so readers and search engines can scan it.',
    );
  const firstHeading = headings[0];
  if (firstHeading && firstHeading.level === 3)
    warn('blocks', 'The first heading is an H3; start sections with an H2.');
  const internal = links.map(internalPath).filter((p): p is string => p !== null);
  if (internal.length === 0 && words > 300)
    info(
      'blocks',
      'No links to other Veyrafy pages: link to related articles where it helps the reader.',
    );
  if (knownPaths)
    for (const p of internal) {
      const path = p.replace(/\/+$/, '') || '/';
      if (!knownPaths.has(path)) warn('blocks', `Internal link to a page that is not public: ${p}`);
    }
  const keyword = a.focusKeyword?.trim().toLowerCase();
  if (keyword) {
    const firstParagraph = a.blocks.find((b) => b.type === 'paragraph');
    const where = [
      ['the title', seoTitle],
      ['the meta description', meta || a.excerpt],
      [
        'the first paragraph',
        firstParagraph?.type === 'paragraph' ? inlineText(firstParagraph.text) : '',
      ],
    ] as const;
    const missing = where
      .filter(([, text]) => !text.toLowerCase().includes(keyword))
      .map(([n]) => n);
    if (missing.length)
      info(
        'focusKeyword',
        `The focus phrase does not appear in ${missing.join(', ')}. Use it only where it reads naturally.`,
      );
  }
  if (a.noindex) info('noindex', 'Search engines are asked not to index this article.');
  if (a.canonicalUrl)
    info(
      'canonicalUrl',
      'This article names another page as its canonical: it is left out of the sitemap.',
    );
  return issues;
}

export const blockingIssues = (issues: readonly BlogIssue[]): BlogIssue[] =>
  issues.filter((i) => i.level === 'error');

// ── Limits ───────────────────────────────────────────────────────────────────

export const BLOG_LIMITS = {
  title: 160,
  excerpt: 400,
  seoTitle: 120,
  metaDescription: 320,
  blocks: 400,
  blockText: 8000,
  listItems: 60,
  tableColumns: 8,
  tableRows: 80,
  faq: 20,
  /** An uploaded image, before it is re-encoded. */
  mediaBytes: 8 * 1024 * 1024,
  /** Widest stored image (larger ones are scaled down). */
  mediaWidth: 1600,
  pageSize: 12,
} as const;
