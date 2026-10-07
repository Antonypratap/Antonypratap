import { createCanvas } from '@napi-rs/canvas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { BlogArticleInput } from '@veyra/shared';
import { openVeyraDb, type VeyraDatabase } from '../db/open';
import { ORGANIZATION_ID } from '../workflow/veyra';
import { PLATFORM_ORGANIZATION_ID } from '../db/schema';
import { SessionStore } from '../auth/sessions';
import { Users } from '../auth/users';
import { buildSiteServer } from '../http/site-server';
import type { WebFiles } from '../http/web-static';
import { createTestDatabase, type TestDatabase } from '../test/database';
import { BlogService } from './service';

/**
 * The website with its blog, end to end over HTTP (Fastify inject): what crawlers receive (the
 * HTML source itself), what the sitemap lists, and who may use the studio's API. Made-up content.
 */
const ORIGIN = 'https://veyrafy.com';
let database: TestDatabase;
let handle: VeyraDatabase;
let app: FastifyInstance;
let blog: BlogService;
let now = new Date('2026-10-01T09:00:00.000Z');
let editor: { cookie: string; csrf: string };
let author: string;
let category: string;

const html = (s: string) => ({ body: Buffer.from(s), type: 'text/html; charset=utf-8' });
const web: WebFiles = (() => {
  const index = html(
    '<!doctype html><html><head><title>Veyrafy</title></head><body><div id="root"></div></body></html>',
  );
  return {
    index,
    files: new Map([
      ['/index.html', index],
      [
        '/robots.txt',
        {
          body: Buffer.from('User-agent: *\nAllow: /\nDisallow: /admin/\n'),
          type: 'text/plain; charset=utf-8',
        },
      ],
      [
        '/assets/inter-latin-opsz-normal-AbC123.woff2',
        { body: Buffer.from('font'), type: 'font/woff2' },
      ],
    ]),
  };
})();

async function signIn(email: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0] ?? '';
  return { cookie, csrf: res.json<{ csrfToken: string }>().csrfToken };
}
const as = (who: { cookie: string; csrf: string }) => ({
  cookie: who.cookie,
  'x-veyra-csrf': who.csrf,
});
const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, who = editor) =>
  app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: as(who),
  });

const input = (over: Partial<BlogArticleInput> = {}): BlogArticleInput => ({
  title: 'How to verify a supplier invoice',
  slug: 'verify-a-supplier-invoice',
  excerpt: 'A practical checklist for checking a supplier invoice before payment.',
  blocks: [
    {
      type: 'paragraph',
      text: 'Check the invoice against the **purchase order** and the [goods receipt](/blog/what-is-a-grn).',
    },
    { type: 'heading', level: 2, text: 'Start with the supplier' },
    { type: 'paragraph', text: 'Confirm the supplier name and GSTIN.' },
    { type: 'heading', level: 2, text: 'Then the lines' },
    { type: 'list', ordered: true, items: ['Item', 'Quantity', 'Rate'] },
    { type: 'heading', level: 3, text: 'Rates' },
    { type: 'table', header: ['Check', 'Against'], rows: [['Rate', 'Order']] },
    { type: 'heading', level: 2, text: 'Finally the tax' },
    { type: 'paragraph', text: 'Check CGST and SGST, or IGST.' },
  ],
  faq: [{ q: 'What is a GRN?', a: 'A goods receipt note records what arrived.' }],
  authorId: author,
  categoryId: category,
  tagIds: [],
  seoTitle: 'Verify a Supplier Invoice Before Payment',
  metaDescription:
    'A practical checklist for checking a supplier invoice against the order, the goods received and GST before you pay.',
  canonicalUrl: null,
  noindex: false,
  ogTitle: null,
  ogDescription: null,
  ogImageId: null,
  twitterCard: 'summary_large_image',
  focusKeyword: 'verify supplier invoice',
  featuredMediaId: null,
  featuredAlt: null,
  cta: 'challenge',
  ...over,
});

async function publish(over: Partial<BlogArticleInput> = {}) {
  const created = await api('POST', '/api/v1/blog/articles', input(over));
  expect(created.statusCode, created.body).toBe(201);
  const a = created.json<{ id: string; version: number }>();
  const p = await api('POST', `/api/v1/blog/articles/${a.id}/status`, {
    to: 'PUBLISHED',
    baseVersion: a.version,
  });
  expect(p.statusCode, p.body).toBe(200);
  return p.json<{ id: string; version: number; slug: string }>();
}

const ldOf = (body: string) =>
  [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => JSON.parse(m[1] ?? 'null') as Record<string, unknown>,
  );

beforeAll(async () => {
  database = await createTestDatabase();
  handle = await openVeyraDb({ url: database.url, migrate: false, pool: { max: 4 } });
  blog = new BlogService({ db: handle.db, clock: () => now });
  const sessions = new SessionStore(handle.db, { idleMs: 3_600_000, absoluteMs: 7_200_000 });
  const users = new Users(handle.db, sessions, PLATFORM_ORGANIZATION_ID);
  await users.create(
    {
      email: 'editor@veyrafy.example',
      name: 'Ed Itor',
      role: 'VEYRA_ADMIN',
      password: 'a long editor password',
    },
    { userId: null, requestId: null },
  );
  // A customer administrator (another organization) must never reach the studio.
  await new Users(handle.db, sessions, ORGANIZATION_ID).create(
    {
      email: 'admin@customer.example',
      name: 'Cust Omer',
      role: 'ADMIN',
      password: 'a long customer password',
    },
    { userId: null, requestId: null },
  );
  app = await buildSiteServer({
    web,
    hsts: true,
    release: null,
    analytics: { ga4MeasurementId: 'G-TEST1234', gscVerification: 'gsc-token-0123456789' },
    blog: {
      service: blog,
      sessions,
      users,
      cookieSecure: false,
      publicOrigins: [ORIGIN],
      origin: ORIGIN,
      loginPerMinute: 100,
      promoteEveryMs: 0,
    },
  });
  editor = await signIn('editor@veyrafy.example', 'a long editor password');
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await database.drop();
});
beforeEach(async () => {
  now = new Date('2026-10-01T09:00:00.000Z');
  await handle.db.execute(
    sql`TRUNCATE blog_events, blog_redirects, blog_revisions, blog_article_tags, blog_articles, blog_media, blog_tags, blog_categories, blog_authors`,
  );
  author = await blog.saveAuthor(
    null,
    { name: 'Asha Rao', slug: 'asha-rao', role: 'Finance operations' },
    null,
  );
  category = await blog.saveCategory(
    null,
    {
      name: 'Invoice Verification',
      slug: 'invoice-verification',
      description: 'Checking invoices before payment.',
    },
    null,
  );
});

describe('the studio API: who may use it', () => {
  it('every studio route declares a blog permission; nobody signed out gets in', async () => {
    const routes = (
      app as unknown as { routeAccess: { url: string; access: string }[] }
    ).routeAccess.filter((r) => r.url.startsWith('/api/v1/blog'));
    expect(routes.length).toBeGreaterThan(15);
    expect(routes.every((r) => r.access.startsWith('blog.'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/v1/blog/articles' })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/blog/articles', payload: input() }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/blog/preview/01HZZZZZZZZZZZZZZZZZZZZZZZ' }))
        .statusCode,
    ).toBe(401);
  });

  it('a customer account cannot sign in here or use the studio', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@customer.example', password: 'a long customer password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a change without the CSRF token, or from another site', async () => {
    const noToken = await app.inject({
      method: 'POST',
      url: '/api/v1/blog/articles',
      payload: input(),
      headers: { cookie: editor.cookie },
    });
    expect(noToken.statusCode).toBe(403);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/v1/blog/articles',
      payload: input(),
      headers: { ...as(editor), origin: 'https://evil.example' },
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it('creates, edits with versions, and refuses a duplicate slug', async () => {
    const a = await api('POST', '/api/v1/blog/articles', input());
    expect(a.statusCode).toBe(201);
    const { id, version } = a.json<{ id: string; version: number }>();
    expect((await api('POST', '/api/v1/blog/articles', input({ title: 'Other' }))).statusCode).toBe(
      409,
    );
    const saved = await api('PUT', `/api/v1/blog/articles/${id}`, {
      article: input({ title: 'Edited' }),
      baseVersion: version,
      autosave: false,
    });
    expect(saved.json()).toMatchObject({ version: version + 1, title: 'Edited' });
    const stale = await api('PUT', `/api/v1/blog/articles/${id}`, {
      article: input(),
      baseVersion: version,
      autosave: true,
    });
    expect(stale.statusCode).toBe(409);
    const list = await api('GET', '/api/v1/blog/articles?status=DRAFT');
    expect(list.json<unknown[]>()).toHaveLength(1);
    const checks = await api('POST', '/api/v1/blog/checks', input({ excerpt: '' }));
    expect(checks.json<{ issues: { level: string; field: string }[] }>().issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: 'error', field: 'excerpt' })]),
    );
  });
});

describe('what readers and crawlers receive', () => {
  it('a draft is not public anywhere; its preview is for editors only and never indexed', async () => {
    const a = (await api('POST', '/api/v1/blog/articles', input())).json<{ id: string }>();
    expect(
      (await app.inject({ method: 'GET', url: '/blog/verify-a-supplier-invoice' })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/blog' })).body).not.toContain(
      'verify-a-supplier-invoice',
    );
    expect((await app.inject({ method: 'GET', url: '/sitemap.xml' })).body).not.toContain(
      'verify-a-supplier-invoice',
    );
    const preview = await app.inject({
      method: 'GET',
      url: `/blog/preview/${a.id}`,
      headers: { cookie: editor.cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(preview.body).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(preview.body).not.toContain('application/ld+json');
  });

  it('a published article: complete HTML with unique metadata, canonical and valid structured data', async () => {
    await publish();
    const res = await app.inject({ method: 'GET', url: '/blog/verify-a-supplier-invoice' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const b = res.body;
    expect(b).toContain('<title>Verify a Supplier Invoice Before Payment | Veyrafy</title>');
    expect(b).toContain(
      '<meta name="description" content="A practical checklist for checking a supplier invoice against the order, the goods received and GST before you pay.">',
    );
    expect(b).toContain(`<link rel="canonical" href="${ORIGIN}/blog/verify-a-supplier-invoice">`);
    expect(b).toContain('<meta name="robots" content="index, follow, max-image-preview:large">');
    expect(b).toContain('<meta property="og:type" content="article">');
    expect(b).toContain(
      `<meta property="og:url" content="${ORIGIN}/blog/verify-a-supplier-invoice">`,
    );
    expect(b).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(b).toContain('<meta name="google-site-verification" content="gsc-token-0123456789">');
    expect(b.match(/<h1[ >]/g)).toHaveLength(1);
    expect(b).toContain('<h2 id="start-with-the-supplier">Start with the supplier</h2>');
    expect(b).toContain('<h3 id="rates">Rates</h3>');
    expect(b).toContain('<nav class="toc"');
    expect(b).toContain('<nav class="crumbs" aria-label="Breadcrumb">');
    expect(b).toContain('<strong>purchase order</strong>');
    expect(b).toContain('<a href="/blog/what-is-a-grn">goods receipt</a>');
    expect(b).toContain(
      'href="/5-invoice-challenge?utm_source=blog&amp;utm_medium=cta&amp;utm_campaign=verify-a-supplier-invoice"',
    );
    expect(b.match(/<title>/g)).toHaveLength(1);
    expect(b.match(/rel="canonical"/g)).toHaveLength(1);
    const ld = ldOf(b);
    const posting = ld.find((d) => d['@type'] === 'BlogPosting');
    expect(posting).toMatchObject({
      '@context': 'https://schema.org',
      headline: 'How to verify a supplier invoice',
      datePublished: '2026-10-01T09:00:00.000Z',
      dateModified: '2026-10-01T09:00:00.000Z',
      author: { '@type': 'Person', name: 'Asha Rao' },
      publisher: { '@type': 'Organization', name: 'Veyrafy' },
      mainEntityOfPage: { '@type': 'WebPage', '@id': `${ORIGIN}/blog/verify-a-supplier-invoice` },
      articleSection: 'Invoice Verification',
    });
    expect(ld.find((d) => d['@type'] === 'BreadcrumbList')).toMatchObject({
      itemListElement: [
        { position: 1, name: 'Home', item: `${ORIGIN}/` },
        { position: 2, name: 'Blog', item: `${ORIGIN}/blog` },
        {
          position: 3,
          name: 'Invoice Verification',
          item: `${ORIGIN}/blog/category/invoice-verification`,
        },
        {
          position: 4,
          name: 'How to verify a supplier invoice',
          item: `${ORIGIN}/blog/verify-a-supplier-invoice`,
        },
      ],
    });
    expect(ld.find((d) => d['@type'] === 'FAQPage')).toMatchObject({
      mainEntity: [
        {
          '@type': 'Question',
          name: 'What is a GRN?',
          acceptedAnswer: { text: 'A goods receipt note records what arrived.' },
        },
      ],
    });
    // No ratings, reviews or anything not on the page.
    expect(b).not.toMatch(/aggregateRating|"Review"/);
  });

  it('escapes everything stored: no script, and unsafe links are never rendered as links', async () => {
    const a = (
      await api(
        'POST',
        '/api/v1/blog/articles',
        input({
          title: '</title><script>alert(1)</script>',
          blocks: [
            {
              type: 'paragraph',
              text: 'Click [here](javascript:alert(1)) or <img src=x onerror=alert(1)>',
            },
          ],
          excerpt: '"><script>alert(2)</script>',
        }),
      )
    ).json<{ id: string }>();
    const res = await app.inject({
      method: 'GET',
      url: `/blog/preview/${a.id}`,
      headers: { cookie: editor.cookie },
    });
    expect(res.body).not.toMatch(/<script>alert/);
    expect(res.body).not.toContain('javascript:');
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    // And it cannot be published with an unsafe link.
    const p = await api('POST', `/api/v1/blog/articles/${a.id}/status`, {
      to: 'PUBLISHED',
      baseVersion: 1,
    });
    expect(p.statusCode).toBe(422);
  });

  it('the sitemap lists only public, indexable, self-canonical pages', async () => {
    await publish();
    await publish({ slug: 'noindexed', title: 'Hidden', noindex: true });
    await publish({
      slug: 'canonical-elsewhere',
      title: 'Copy',
      canonicalUrl: 'https://example.com/original',
    });
    const draft = (
      await api('POST', '/api/v1/blog/articles', input({ slug: 'a-draft', title: 'Draft' }))
    ).json<{ id: string; version: number }>();
    const future = (
      await api('POST', '/api/v1/blog/articles', input({ slug: 'future', title: 'Future' }))
    ).json<{ id: string; version: number }>();
    await api('POST', `/api/v1/blog/articles/${future.id}/status`, {
      to: 'SCHEDULED',
      publishAt: '2026-10-09T09:00:00.000Z',
      baseVersion: future.version,
    });
    const res = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    expect(res.headers['content-type']).toContain('application/xml');
    const locs = [...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/blog`,
      `${ORIGIN}/blog/category/invoice-verification`,
      `${ORIGIN}/blog/verify-a-supplier-invoice`,
    ]);
    expect(res.body).toContain('<lastmod>2026-10-01</lastmod>');
    expect(draft.id).toBeTruthy();
    // The noindexed article tells crawlers so, in the page and the header.
    const hidden = await app.inject({ method: 'GET', url: '/blog/noindexed' });
    expect(hidden.body).toContain('<meta name="robots" content="noindex, follow">');
    expect(hidden.headers['x-robots-tag']).toBe('noindex, follow');
    expect((await app.inject({ method: 'GET', url: '/blog/canonical-elsewhere' })).body).toContain(
      '<link rel="canonical" href="https://example.com/original">',
    );
  });

  it('a scheduled article appears at its time, not a moment before', async () => {
    const a = (await api('POST', '/api/v1/blog/articles', input())).json<{
      id: string;
      version: number;
    }>();
    const s = await api('POST', `/api/v1/blog/articles/${a.id}/status`, {
      to: 'SCHEDULED',
      publishAt: '2026-10-02T03:30:00.000Z',
      baseVersion: a.version,
    });
    expect(s.json()).toMatchObject({ status: 'SCHEDULED', live: false });
    now = new Date('2026-10-02T03:29:59.000Z');
    expect(
      (await app.inject({ method: 'GET', url: '/blog/verify-a-supplier-invoice' })).statusCode,
    ).toBe(404);
    now = new Date('2026-10-02T03:30:00.000Z');
    expect(
      (await app.inject({ method: 'GET', url: '/blog/verify-a-supplier-invoice' })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/sitemap.xml' })).body).toContain(
      '/blog/verify-a-supplier-invoice',
    );
  });

  it('a changed slug redirects permanently; unpublished is 404; archived is 410', async () => {
    const a = await publish();
    const moved = await api('PUT', `/api/v1/blog/articles/${a.id}`, {
      article: input({ slug: 'supplier-invoice-checklist' }),
      baseVersion: a.version,
      autosave: false,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const r = await app.inject({ method: 'GET', url: '/blog/verify-a-supplier-invoice' });
    expect(r.statusCode).toBe(301);
    expect(r.headers.location).toBe('/blog/supplier-invoice-checklist');
    const v = moved.json<{ version: number }>().version;
    const un = await api('POST', `/api/v1/blog/articles/${a.id}/status`, {
      to: 'DRAFT',
      baseVersion: v,
    });
    const gone404 = await app.inject({ method: 'GET', url: '/blog/supplier-invoice-checklist' });
    expect(gone404.statusCode).toBe(404);
    expect(gone404.headers['x-robots-tag']).toBe('noindex');
    const ar = await api('POST', `/api/v1/blog/articles/${a.id}/status`, {
      to: 'ARCHIVED',
      baseVersion: un.json<{ version: number }>().version,
    });
    expect(ar.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/blog/supplier-invoice-checklist' })).statusCode,
    ).toBe(410);
    expect((await app.inject({ method: 'GET', url: '/blog/never-existed' })).statusCode).toBe(404);
  });

  it('crawlable pagination, trailing slashes and archives', async () => {
    for (let i = 1; i <= 14; i++) {
      now = new Date(Date.UTC(2026, 9, 1, 9, i));
      await publish({
        slug: `article-${i}`,
        title: `Article number ${i}`,
        ...(i === 2
          ? { tagIds: [await blog.saveTag(null, { name: 'GST', slug: 'gst' }, null)] }
          : {}),
      });
    }
    const p1 = await app.inject({ method: 'GET', url: '/blog' });
    expect(p1.body).toContain(`<link rel="next" href="${ORIGIN}/blog/page/2">`);
    expect(p1.body).toContain('href="/blog/page/2" rel="next"');
    expect(p1.body).toContain('<h2 class="sr">Featured article</h2>');
    const p2 = await app.inject({ method: 'GET', url: '/blog/page/2' });
    expect(p2.statusCode).toBe(200);
    expect(p2.body).toContain(`<link rel="canonical" href="${ORIGIN}/blog/page/2">`);
    expect(p2.body).toContain(`<link rel="prev" href="${ORIGIN}/blog">`);
    expect(p2.body).toContain('<title>Veyrafy Blog: Invoice Verification Guides (Page 2)</title>');
    expect((await app.inject({ method: 'GET', url: '/blog/page/3' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/blog/page/1' })).headers.location).toBe(
      '/blog',
    );
    const slash = await app.inject({ method: 'GET', url: '/blog/article-3/' });
    expect([slash.statusCode, slash.headers.location]).toEqual([301, '/blog/article-3']);
    expect((await app.inject({ method: 'GET', url: '/blog/' })).headers.location).toBe('/blog');
    const cat = await app.inject({ method: 'GET', url: '/blog/category/invoice-verification' });
    expect(cat.statusCode).toBe(200);
    expect(cat.body).toContain(
      '<meta name="robots" content="index, follow, max-image-preview:large">',
    );
    const tag = await app.inject({ method: 'GET', url: '/blog/tag/gst' });
    expect(tag.statusCode).toBe(200);
    expect(tag.body).toContain('<meta name="robots" content="noindex, follow">');
    expect(
      (await app.inject({ method: 'GET', url: '/blog/category/nothing-here' })).statusCode,
    ).toBe(404);
    const feed = await app.inject({ method: 'GET', url: '/blog/feed.xml' });
    expect(feed.headers['content-type']).toContain('application/rss+xml');
    expect(feed.body).toContain(`<link>${ORIGIN}/blog/article-14</link>`);
    const search = await app.inject({ method: 'GET', url: '/blog/search?q=number%207' });
    expect(search.headers['x-robots-tag']).toBe('noindex, follow');
    expect(search.body).toContain('/blog/article-7');
  });

  it('analytics load only after the visitor agrees, and the page CSP allows Google only then', async () => {
    await publish();
    const before = await app.inject({ method: 'GET', url: '/blog/verify-a-supplier-invoice' });
    expect(before.body).not.toContain('googletagmanager');
    expect(before.body).toContain('action="/blog/consent"');
    // Browsers send the page's real Origin on its own form posts only with a referrer policy
    // other than no-referrer.
    expect(before.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(String(before.headers['content-security-policy'])).not.toContain('googletagmanager');
    const choice = await app.inject({
      method: 'POST',
      url: '/blog/consent',
      payload: 'choice=granted&return=%2Fblog%2Fverify-a-supplier-invoice',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    });
    expect(choice.statusCode).toBe(303);
    expect(choice.headers.location).toBe('/blog/verify-a-supplier-invoice');
    const consent = String(choice.headers['set-cookie']);
    expect(consent).toMatch(/veyrafy_analytics=granted;.*HttpOnly/i);
    const after = await app.inject({
      method: 'GET',
      url: '/blog/verify-a-supplier-invoice',
      headers: { cookie: consent.split(';')[0] ?? '' },
    });
    expect(after.body).toContain('https://www.googletagmanager.com/gtag/js?id=G-TEST1234');
    expect(after.body).not.toContain('action="/blog/consent"');
    expect(String(after.headers['content-security-policy'])).toContain(
      "script-src 'self' https://www.googletagmanager.com",
    );
    const denied = await app.inject({
      method: 'GET',
      url: '/blog/verify-a-supplier-invoice',
      headers: { cookie: 'veyrafy_analytics=denied' },
    });
    expect(denied.body).not.toContain('googletagmanager');
    // A consent form from another site is refused.
    const forged = await app.inject({
      method: 'POST',
      url: '/blog/consent',
      payload: 'choice=granted',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
    });
    expect(forged.statusCode).toBe(403);
  });

  it('image upload: only real images, re-encoded and served safely', async () => {
    const boundary = '----blogtest';
    const upload = (name: string, bytes: Buffer) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/blog/media',
        headers: { ...as(editor), 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="alt"\r\n\r\nA chart\r\n`,
          ),
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    const svg = await upload(
      'x.png',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
    );
    expect(svg.statusCode).toBe(415);
    const canvas = createCanvas(1200, 630);
    canvas.getContext('2d').fillRect(0, 0, 10, 10);
    const ok = await upload('chart.png', canvas.toBuffer('image/png'));
    expect(ok.statusCode, ok.body).toBe(201);
    const m = ok.json<{ id: string; url: string; alt: string; width: number }>();
    expect(m).toMatchObject({ alt: 'A chart', width: 1200 });
    const file = await app.inject({ method: 'GET', url: m.url });
    expect(file.headers['content-type']).toBe('image/webp');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(file.headers['cache-control']).toContain('immutable');
    expect(
      (await app.inject({ method: 'GET', url: '/blog/media/not-an-id.webp' })).statusCode,
    ).toBe(404);
  });

  it('the website itself is unchanged: homepage, robots.txt, health', async () => {
    const home = await app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain(
      '<meta name="google-site-verification" content="gsc-token-0123456789" />',
    );
    expect((await app.inject({ method: 'GET', url: '/robots.txt' })).body).toContain(
      'Disallow: /admin/',
    );
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).json()).toMatchObject({
      ok: true,
      site: true,
      blog: true,
    });
    // The studio's address is the web app (it signs in and calls the API).
    expect((await app.inject({ method: 'GET', url: '/admin/blog' })).body).toContain(
      '<div id="root">',
    );
  });
});
