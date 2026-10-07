import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { openVeyraDb } from '../db/open';
import { createTestDatabase, testDatabaseUrl } from '../test/database';
import { BlogService } from './service';
import { seedBlog } from './seed';

/**
 * The blog under the documented least-privilege runtime role (apps/api/sql/runtime-role.sql): it
 * can do everything the studio does, deleting only an article's tag assignments; it cannot delete
 * articles or rewrite the publishing history.
 */
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function asAdmin(url: string, text: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(text);
  } finally {
    await c.end();
  }
}

describe('the blog under the runtime role', () => {
  it('writes, tags, untags, publishes, uploads and retires; never deletes articles or history', async () => {
    const database = await createTestDatabase();
    const role = `veyra_app_${randomBytes(4).toString('hex')}`;
    const password = `test-only-${randomBytes(6).toString('hex')}`;
    await asAdmin(testDatabaseUrl(), `create role ${role} login password '${password}'`);
    cleanup.push(() => asAdmin(testDatabaseUrl(), `drop role if exists ${role}`));
    cleanup.push(() => database.drop());
    const script = readFileSync(new URL('../../sql/runtime-role.sql', import.meta.url), 'utf8');
    await asAdmin(database.url, script.replaceAll('veyra_app', role));
    await asAdmin(
      database.url,
      `grant connect on database "${new URL(database.url).pathname.slice(1)}" to ${role}`,
    );
    const u = new URL(database.url);
    u.username = role;
    u.password = password;
    const handle = await openVeyraDb({ url: u.toString(), migrate: false, pool: { max: 2 } });
    cleanup.push(() => handle.close());
    const blog = new BlogService({ db: handle.db });

    await seedBlog(blog);
    const [cat] = await blog.categories();
    const [author] = await blog.authors();
    const tagA = await blog.saveTag(null, { name: 'GST', slug: 'gst' }, null);
    const tagB = await blog.saveTag(null, { name: 'GRN', slug: 'grn' }, null);
    const canvas = createCanvas(900, 500);
    canvas.getContext('2d').fillRect(0, 0, 10, 10);
    const image = await blog.upload(
      new Uint8Array(canvas.toBuffer('image/png')),
      'A chart',
      null as never,
    );
    const input = {
      title: 'Runtime role article',
      slug: 'runtime-role-article',
      excerpt: 'Written by the runtime role.',
      blocks: [{ type: 'paragraph' as const, text: 'Body.' }],
      faq: [],
      authorId: author?.id ?? null,
      categoryId: cat?.id ?? null,
      tagIds: [tagA, tagB],
      seoTitle: null,
      metaDescription: null,
      canonicalUrl: null,
      noindex: false,
      ogTitle: null,
      ogDescription: null,
      ogImageId: null,
      twitterCard: 'summary_large_image' as const,
      focusKeyword: null,
      featuredMediaId: image.id,
      featuredAlt: 'A chart',
      cta: 'challenge' as const,
    };
    const a = await blog.create(input, null);
    const untagged = await blog.save(
      a.id,
      { ...input, tagIds: [tagB] },
      a.version,
      false,
      null as never,
    );
    expect(untagged.article.tagIds).toEqual([tagB]);
    const p = await blog.changeStatus(a.id, 'PUBLISHED', null, untagged.version, null as never);
    await blog.save(
      a.id,
      { ...input, tagIds: [tagB], slug: 'runtime-role-moved' },
      p.version,
      false,
      null as never,
    );
    expect(await blog.resolveRedirect('/blog/runtime-role-article')).toBe(
      '/blog/runtime-role-moved',
    );
    const spare = await blog.upload(
      new Uint8Array(createCanvas(50, 50).toBuffer('image/png')),
      '',
      null as never,
    );
    await blog.retireMedia(spare.id, null as never);
    const draft = await blog.duplicate(a.id, null as never);
    await blog.remove(draft.id, draft.version, null as never);

    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    cleanup.push(() => c.end());
    await expect(c.query('delete from blog_articles')).rejects.toThrow(/permission denied/);
    await expect(c.query(`update blog_events set event = 'article.updated'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(c.query('delete from blog_events')).rejects.toThrow(/permission denied/);
  });
});
