import { createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { BlogArticleInput } from '@veyra/shared';
import { openVeyraDb, type VeyraDatabase } from '../db/open';
import * as t from '../db/schema';
import { createTestDatabase, type TestDatabase } from '../test/database';
import { BlogService } from './service';
import { blockingIssues, blogChecks } from '@veyra/shared';
import { BLOG_ARTICLES } from './articles';
import { seedBlog } from './seed';

/** The blog's rules, against a real PostgreSQL database. All content here is made up. */
let database: TestDatabase;
let handle: VeyraDatabase;
let now = new Date('2026-10-01T09:00:00.000Z');
let blog: BlogService;
let author: string;
let category: string;

beforeAll(async () => {
  database = await createTestDatabase();
  handle = await openVeyraDb({ url: database.url, migrate: false, pool: { max: 2 } });
  blog = new BlogService({ db: handle.db, clock: () => now });
});
afterAll(async () => {
  await handle.close();
  await database.drop();
});
beforeEach(async () => {
  now = new Date('2026-10-01T09:00:00.000Z');
  await handle.db.execute(
    sql`TRUNCATE blog_events, blog_redirects, blog_revisions, blog_article_tags, blog_articles, blog_media, blog_tags, blog_categories, blog_authors`,
  );
  author = await blog.saveAuthor(null, { name: 'A. Writer', slug: 'a-writer' }, null);
  category = await blog.saveCategory(
    null,
    { name: 'Invoice Verification', slug: 'invoice-verification' },
    null,
  );
});

const article = (over: Partial<BlogArticleInput> = {}): BlogArticleInput => ({
  title: 'How to check an invoice',
  slug: 'how-to-check-an-invoice',
  excerpt: 'A short guide to checking a supplier invoice before payment.',
  blocks: [
    { type: 'paragraph', text: 'Check the invoice against the order and the goods received.' },
    { type: 'heading', level: 2, text: 'The order' },
    { type: 'paragraph', text: 'Compare each line with the purchase order.' },
  ],
  faq: [],
  authorId: author,
  categoryId: category,
  tagIds: [],
  seoTitle: null,
  metaDescription:
    'How to check a supplier invoice against the order and goods received before you approve payment for it.',
  canonicalUrl: null,
  noindex: false,
  ogTitle: null,
  ogDescription: null,
  ogImageId: null,
  twitterCard: 'summary_large_image',
  focusKeyword: null,
  featuredMediaId: null,
  featuredAlt: null,
  cta: 'challenge',
  ...over,
});

const png = (w: number, h: number) => {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#145c46';
  ctx.fillRect(0, 0, w, h);
  return new Uint8Array(c.toBuffer('image/png'));
};

describe('blog service', () => {
  it('creates drafts that are never public; slugs are unique and validated', async () => {
    const a = await blog.create(article(), null);
    expect(a.status).toBe('DRAFT');
    expect(a.live).toBe(false);
    expect(await blog.publicArticle(a.slug)).toBeNull();
    await expect(blog.create(article({ title: 'Other' }), null)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(blog.create(article({ slug: 'Bad Slug' }), null)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(blog.create(article({ slug: 'search' }), null)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('publishes only a complete article; an outline with editorial notes is refused', async () => {
    const outline = await blog.create(
      article({
        slug: 'outline',
        blocks: [
          { type: 'note', text: 'To write' },
          { type: 'paragraph', text: 'x' },
        ],
      }),
      null,
    );
    await expect(
      blog.changeStatus(outline.id, 'PUBLISHED', null, outline.version, 'x'),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const noAuthor = await blog.create(article({ slug: 'no-author', authorId: null }), null);
    await expect(
      blog.changeStatus(noAuthor.id, 'PUBLISHED', null, noAuthor.version, 'x'),
    ).rejects.toMatchObject({
      details: { issues: [expect.objectContaining({ field: 'authorId' })] },
    });
    const ok = await blog.create(article(), null);
    const published = await blog.changeStatus(ok.id, 'PUBLISHED', null, ok.version, null as never);
    expect(published).toMatchObject({
      status: 'PUBLISHED',
      live: true,
      publishedAt: now.toISOString(),
    });
    expect((await blog.publicArticle(ok.slug))?.row.id).toBe(ok.id);
  });

  it('a scheduled article is not public a moment before its time, and is at its time', async () => {
    const a = await blog.create(article(), null);
    await expect(
      blog.changeStatus(a.id, 'SCHEDULED', '2026-10-01T08:00:00.000Z', a.version, null as never),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const s = await blog.changeStatus(
      a.id,
      'SCHEDULED',
      '2026-10-02T06:00:00.000Z',
      a.version,
      null as never,
    );
    expect(s.live).toBe(false);
    now = new Date('2026-10-02T05:59:59.999Z');
    expect(await blog.publicArticle(a.slug)).toBeNull();
    expect((await blog.publicPage({ page: 1 })).total).toBe(0);
    expect(await blog.sitemapArticles()).toEqual([]);
    now = new Date('2026-10-02T06:00:00.000Z');
    expect((await blog.publicArticle(a.slug))?.row.id).toBe(a.id);
    expect(await blog.promoteDue()).toBe(1);
    expect((await blog.get(a.id)).status).toBe('PUBLISHED');
  });

  it('refuses a save from a stale version, and autosave of a live article', async () => {
    const a = await blog.create(article(), null);
    const saved = await blog.save(
      a.id,
      article({ title: 'New title' }),
      a.version,
      false,
      null as never,
    );
    expect(saved.version).toBe(a.version + 1);
    await expect(blog.save(a.id, article(), a.version, false, null as never)).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
    const live = await blog.changeStatus(a.id, 'PUBLISHED', null, saved.version, null as never);
    await expect(
      blog.save(a.id, article(), live.version, true, null as never),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // A published article cannot be saved into an unpublishable state.
    await expect(
      blog.save(a.id, article({ excerpt: '' }), live.version, false, null as never),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('changing a published slug leaves a 301 redirect, without chains', async () => {
    const a = await blog.create(article({ slug: 'first' }), null);
    const p = await blog.changeStatus(a.id, 'PUBLISHED', null, a.version, null as never);
    const b = await blog.save(a.id, article({ slug: 'second' }), p.version, false, null as never);
    await blog.save(a.id, article({ slug: 'third' }), b.version, false, null as never);
    expect(await blog.resolveRedirect('/blog/first')).toBe('/blog/third');
    expect(await blog.resolveRedirect('/blog/second')).toBe('/blog/third');
    expect((await blog.redirects()).map((r) => r.fromPath).sort()).toEqual([
      '/blog/first',
      '/blog/second',
    ]);
    // A draft that was never public leaves no redirect.
    const d = await blog.create(article({ slug: 'draft-one', title: 'D' }), null);
    await blog.save(
      d.id,
      article({ slug: 'draft-two', title: 'D' }),
      d.version,
      false,
      null as never,
    );
    expect(await blog.resolveRedirect('/blog/draft-one')).toBeNull();
  });

  it('unpublish hides it at once; archive answers gone; republish keeps the original date', async () => {
    const a = await blog.create(article(), null);
    let v = await blog.changeStatus(a.id, 'PUBLISHED', null, a.version, null as never);
    const firstDate = v.publishedAt;
    v = await blog.changeStatus(a.id, 'DRAFT', null, v.version, null as never);
    expect(await blog.publicArticle(a.slug)).toBeNull();
    now = new Date('2026-10-05T09:00:00.000Z');
    v = await blog.changeStatus(a.id, 'PUBLISHED', null, v.version, null as never);
    expect(v.publishedAt).toBe(firstDate);
    expect(v.contentUpdatedAt).toBe(now.toISOString());
    v = await blog.changeStatus(a.id, 'ARCHIVED', null, v.version, null as never);
    expect(await blog.publicArticle(a.slug)).toBeNull();
    expect(await blog.gone(a.slug)).toBe(true);
    await expect(
      blog.changeStatus(a.id, 'PUBLISHED', null, v.version, null as never),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    // A public article is archived, never deleted.
    await expect(blog.remove(a.id, v.version, null as never)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('keeps revisions and restores one as a new version', async () => {
    const a = await blog.create(article(), null);
    const b = await blog.save(
      a.id,
      article({ title: 'Second title' }),
      a.version,
      false,
      null as never,
    );
    const revs = await blog.revisions(a.id);
    expect(revs.map((r) => r.title)).toEqual(['Second title', 'How to check an invoice']);
    const first = revs.at(-1);
    if (!first) throw new Error('no revision');
    const restored = await blog.restore(a.id, first.id, b.version, null as never);
    expect(restored.article.title).toBe('How to check an invoice');
    expect(restored.version).toBe(b.version + 1);
  });

  it('duplicates as a draft with its own slug; deletes only never-public drafts', async () => {
    const a = await blog.create(article(), null);
    const copy = await blog.duplicate(a.id, null as never);
    expect(copy).toMatchObject({
      status: 'DRAFT',
      slug: 'how-to-check-an-invoice-copy',
      title: 'Copy of How to check an invoice',
    });
    await blog.remove(copy.id, copy.version, null as never);
    await expect(blog.get(copy.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Its slug is free again.
    expect((await blog.duplicate(a.id, null as never)).slug).toBe('how-to-check-an-invoice-copy');
  });

  it('search, pagination and related articles show only public articles', async () => {
    for (let i = 1; i <= 14; i++) {
      const a = await blog.create(
        article({
          slug: `article-${i}`,
          title: `Article ${i} about rates`,
          blocks: [
            {
              type: 'paragraph',
              text: i === 3 ? 'Duplicate invoices are caught here.' : 'Rates and quantities.',
            },
          ],
        }),
        null,
      );
      now = new Date(now.getTime() + 60_000);
      if (i !== 14) await blog.changeStatus(a.id, 'PUBLISHED', null, a.version, null as never);
    }
    const p1 = await blog.publicPage({ page: 1 });
    const p2 = await blog.publicPage({ page: 2 });
    expect(p1.total).toBe(13);
    expect(p1.items).toHaveLength(12);
    expect(p2.items.map((x) => x.slug)).toEqual(['article-1']);
    expect(p1.items[0]?.slug).toBe('article-13');
    const found = await blog.search('duplicate invoices', 1);
    expect(found.items.map((x) => x.slug)).toEqual(['article-3']);
    expect((await blog.search('rates', 1)).items.map((x) => x.slug)).not.toContain('article-14');
    const one = await blog.publicArticle('article-5');
    if (!one) throw new Error('missing');
    expect(await blog.related(one)).toHaveLength(3);
  });

  it('images are re-encoded; anything that is not PNG, JPEG or WebP is refused', async () => {
    const m = await blog.upload(png(2000, 1000), 'A green rectangle', null as never);
    expect(m).toMatchObject({
      width: 1600,
      height: 800,
      alt: 'A green rectangle',
      url: `/blog/media/${m.id}.webp`,
    });
    const file = await blog.mediaFile(m.id, false);
    expect(file?.mime).toBe('image/webp');
    expect(file?.body.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect((await blog.mediaFile(m.id, true))?.body.length).toBeLessThan(file?.body.length ?? 0);
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await expect(blog.upload(svg, '', null as never)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    await expect(blog.upload(html, '', null as never)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
    // A PNG header followed by garbage does not decode.
    const fake = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
    await expect(blog.upload(fake, '', null as never)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
    // An image in use cannot be retired; an unused one can, and is no longer served.
    await blog.create(article({ featuredMediaId: m.id, featuredAlt: 'x' }), null);
    await expect(blog.retireMedia(m.id, null as never)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    const other = await blog.upload(png(100, 100), '', null as never);
    await blog.retireMedia(other.id, null as never);
    expect(await blog.mediaFile(other.id, false)).toBeNull();
  });

  it('seeds six categories and eight complete articles as drafts, idempotently; each can be published', async () => {
    await handle.db.execute(
      sql`TRUNCATE blog_events, blog_revisions, blog_articles, blog_categories, blog_authors CASCADE`,
    );
    const first = await seedBlog(blog);
    expect(first).toEqual({ categories: 6, authors: 1, articles: BLOG_ARTICLES.length });
    expect(BLOG_ARTICLES).toHaveLength(8);
    expect(await seedBlog(blog)).toEqual({ categories: 0, authors: 0, articles: 0 });
    const all = await blog.list({});
    // Drafts only: nothing is public until an editor publishes it.
    expect(all.every((a) => a.status === 'DRAFT' && a.notes === 0 && !a.live)).toBe(true);
    const rows = await handle.db.select().from(t.blogArticles);
    expect(rows.every((r) => r.publishedAt === null)).toBe(true);
    // Complete: each one passes the publication checks, and publishing works.
    const one = all[0];
    if (!one) throw new Error('none');
    const published = await blog.changeStatus(
      one.id,
      'PUBLISHED',
      null,
      one.version,
      null as never,
    );
    expect(published.status).toBe('PUBLISHED');
  });

  it('the seeded articles are complete, linked to each other, and use no dashes as punctuation', () => {
    const slugs = new Set(BLOG_ARTICLES.map((a) => a.slug));
    for (const a of BLOG_ARTICLES) {
      const issues = blogChecks({
        ...a,
        blocks: [...a.blocks],
        faq: [...a.faq],
        authorId: 'author',
        categoryId: 'category',
        tagIds: [],
        canonicalUrl: null,
        noindex: false,
        featuredMediaId: null,
        featuredAlt: null,
      } as never);
      expect({ slug: a.slug, errors: blockingIssues(issues) }).toEqual({
        slug: a.slug,
        errors: [],
      });
      // Search titles and descriptions sized as results show them.
      expect(a.seoTitle.length, a.slug).toBeLessThanOrEqual(60);
      expect(a.metaDescription.length, a.slug).toBeGreaterThanOrEqual(120);
      expect(a.metaDescription.length, a.slug).toBeLessThanOrEqual(160);
      const text = JSON.stringify(a);
      // No double hyphens, em dashes or en dashes anywhere in the content.
      expect(text, a.slug).not.toMatch(/--|\u2014|\u2013|—|–/);
      // The focus phrase is used in the title, the description and the opening paragraph.
      const first = a.blocks.find((b) => b.type === 'paragraph');
      for (const where of [
        a.seoTitle,
        a.metaDescription,
        first?.type === 'paragraph' ? first.text : '',
      ])
        expect(where.toLowerCase(), a.slug).toContain(a.focusKeyword.toLowerCase());
      // Links to other articles point at articles that exist.
      for (const m of text.matchAll(/\]\(\/blog\/([a-z0-9-]+)\)/g))
        expect(slugs.has(m[1] ?? ''), `${a.slug} → ${m[1]}`).toBe(true);
      // Every article invites the reader to the challenge.
      expect(text).toContain('/5-invoice-challenge');
    }
  });
});
