import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  BlogArticleInputSchema,
  BlogBlockSchema,
  BlogFaqSchema,
  articleText,
  blockingIssues,
  blogChecks,
  canMoveBlog,
  slugProblem,
  wordCount,
  type ApiBlogArticle,
  type ApiBlogAuthor,
  type ApiBlogEvent,
  type ApiBlogMedia,
  type ApiBlogRedirect,
  type ApiBlogRevision,
  type ApiBlogSummary,
  type ApiBlogTerm,
  type BlogArticleInput,
  type BlogBlock,
  type BlogEvent,
  type BlogFaq,
  type BlogIssue,
  type BlogStatus,
} from '@veyra/shared';
import { z } from 'zod';
import type { VeyraDb, VeyraTx } from '../db/open';
import * as t from '../db/schema';
import { ulid } from '../ids';
import { VeyraError } from '../workflow/veyra';
import { processImage } from './media';

/**
 * The blog's rules, enforced here (the studio only shows them): who may change what is decided by
 * the route's permission; what a change may do is decided by this service. Every write runs in a
 * transaction; an article's `version` makes a save from a stale copy fail instead of overwriting.
 *
 * Public visibility is decided at read time, never by a timer: an article is public when it is
 * PUBLISHED, or SCHEDULED and its time has come. A scheduled article can never be read early.
 */
export type ArticleRow = typeof t.blogArticles.$inferSelect;
type Db = VeyraDb | VeyraTx;

export interface PublicArticle {
  row: ArticleRow;
  blocks: BlogBlock[];
  faq: BlogFaq[];
  author: typeof t.blogAuthors.$inferSelect | null;
  category: typeof t.blogCategories.$inferSelect | null;
  tags: (typeof t.blogTags.$inferSelect)[];
}

export interface ArticleCard {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  contentUpdatedAt: string | null;
  wordCount: number;
  featuredMediaId: string | null;
  featuredAlt: string | null;
  author: { name: string; slug: string } | null;
  category: { name: string; slug: string } | null;
}

export const articlePath = (slug: string): string => `/blog/${slug}`;
const BlocksSchema = z.array(BlogBlockSchema);
const FaqSchema = z.array(BlogFaqSchema);

export function parseBlocks(json: string): BlogBlock[] {
  return BlocksSchema.parse(JSON.parse(json));
}
export function parseFaq(json: string): BlogFaq[] {
  return FaqSchema.parse(JSON.parse(json));
}

/** Is this row readable at its public address at `now`? */
export function isLive(
  row: Pick<ArticleRow, 'status' | 'publishedAt' | 'deletedAt'>,
  now: string,
): boolean {
  if (row.deletedAt) return false;
  if (row.status === 'PUBLISHED') return true;
  return row.status === 'SCHEDULED' && row.publishedAt !== null && row.publishedAt <= now;
}

export class BlogService {
  readonly db: VeyraDb;
  readonly clock: () => Date;

  constructor(o: { db: VeyraDb; clock?: () => Date }) {
    this.db = o.db;
    this.clock = o.clock ?? (() => new Date());
  }

  now(): string {
    return this.clock().toISOString();
  }

  /** Rows readable by the public right now. */
  livePredicate(now = this.now()): SQL {
    const a = t.blogArticles;
    return and(
      isNull(a.deletedAt),
      or(eq(a.status, 'PUBLISHED'), and(eq(a.status, 'SCHEDULED'), lte(a.publishedAt, now))),
    ) as SQL;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  async record(
    db: Db,
    event: BlogEvent,
    userId: string | null,
    articleId: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await db.insert(t.blogEvents).values({
      id: ulid(),
      event,
      articleId,
      userId,
      detailJson: JSON.stringify(detail),
      createdAt: this.now(),
    });
  }

  async events(articleId: string | null, limit = 100): Promise<ApiBlogEvent[]> {
    const rows = await this.db
      .select({ e: t.blogEvents, name: t.users.name })
      .from(t.blogEvents)
      .leftJoin(t.users, eq(t.users.id, t.blogEvents.userId))
      .where(articleId ? eq(t.blogEvents.articleId, articleId) : undefined)
      .orderBy(desc(t.blogEvents.seq))
      .limit(Math.min(limit, 500));
    return rows.map(({ e, name }) => ({
      id: e.id,
      event: e.event,
      articleId: e.articleId,
      userName: name,
      detail: JSON.parse(e.detailJson) as Record<string, unknown>,
      createdAt: e.createdAt,
    }));
  }

  // ── Studio: reading ───────────────────────────────────────────────────────

  private async tagIdsOf(db: Db, articleId: string): Promise<string[]> {
    const rows = await db
      .select({ id: t.blogArticleTags.tagId })
      .from(t.blogArticleTags)
      .where(eq(t.blogArticleTags.articleId, articleId));
    return rows.map((r) => r.id).sort();
  }

  inputOf(row: ArticleRow, tagIds: string[]): BlogArticleInput {
    return {
      title: row.title,
      slug: row.slug,
      excerpt: row.excerpt,
      blocks: parseBlocks(row.bodyJson),
      faq: parseFaq(row.faqJson),
      authorId: row.authorId,
      categoryId: row.categoryId,
      tagIds,
      seoTitle: row.seoTitle,
      metaDescription: row.metaDescription,
      canonicalUrl: row.canonicalUrl,
      noindex: row.noindex,
      ogTitle: row.ogTitle,
      ogDescription: row.ogDescription,
      ogImageId: row.ogImageId,
      twitterCard: row.twitterCard as BlogArticleInput['twitterCard'],
      focusKeyword: row.focusKeyword,
      featuredMediaId: row.featuredMediaId,
      featuredAlt: row.featuredAlt,
      cta: row.cta as BlogArticleInput['cta'],
    };
  }

  summaryOf(row: ArticleRow): ApiBlogSummary {
    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.status as BlogStatus,
      authorId: row.authorId,
      categoryId: row.categoryId,
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      version: row.version,
      live: isLive(row, this.now()),
      notes: parseBlocks(row.bodyJson).filter((b) => b.type === 'note').length,
    };
  }

  async list(filter: {
    status?: BlogStatus | undefined;
    categoryId?: string | undefined;
    authorId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    q?: string | undefined;
  }): Promise<ApiBlogSummary[]> {
    const a = t.blogArticles;
    const where: SQL[] = [isNull(a.deletedAt)];
    if (filter.status) where.push(eq(a.status, filter.status));
    if (filter.categoryId) where.push(eq(a.categoryId, filter.categoryId));
    if (filter.authorId) where.push(eq(a.authorId, filter.authorId));
    // Date filters apply to the publication date when there is one, else to the last change.
    const when = sql`coalesce(${a.publishedAt}, ${a.updatedAt})`;
    if (filter.from) where.push(sql`${when} >= ${filter.from}`);
    if (filter.to) where.push(sql`${when} <= ${filter.to}`);
    if (filter.q?.trim()) {
      const like = `%${filter.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(sql`(${a.title} ILIKE ${like} OR ${a.slug} ILIKE ${like})`);
    }
    const rows = await this.db
      .select()
      .from(a)
      .where(and(...where))
      .orderBy(desc(a.updatedAt))
      .limit(500);
    return rows.map((r) => this.summaryOf(r));
  }

  private async row(db: Db, id: string): Promise<ArticleRow> {
    const row = (
      await db
        .select()
        .from(t.blogArticles)
        .where(and(eq(t.blogArticles.id, id), isNull(t.blogArticles.deletedAt)))
        .limit(1)
    )[0];
    if (!row) throw new VeyraError('NOT_FOUND', 'Article not found.');
    return row;
  }

  async get(id: string): Promise<ApiBlogArticle> {
    const row = await this.row(this.db, id);
    return this.view(row, await this.tagIdsOf(this.db, id));
  }

  private view(row: ArticleRow, tagIds: string[]): ApiBlogArticle {
    return {
      ...this.summaryOf(row),
      article: this.inputOf(row, tagIds),
      firstPublishedAt: row.firstPublishedAt,
      contentUpdatedAt: row.contentUpdatedAt,
      publicUrl: articlePath(row.slug),
      previewUrl: `/blog/preview/${row.id}`,
    };
  }

  /** The checks for the article as it is now (with the site's public pages, for broken links). */
  async checks(input: BlogArticleInput): Promise<BlogIssue[]> {
    return blogChecks(input, await this.knownPaths());
  }

  // ── Studio: writing ───────────────────────────────────────────────────────

  /** Authors, categories, tags and media an article points to must exist (and not be retired). */
  private async checkReferences(db: Db, a: BlogArticleInput): Promise<void> {
    const missing = (what: string) =>
      new VeyraError('INVALID_INPUT', `The chosen ${what} does not exist.`, { field: what });
    if (
      a.authorId &&
      !(
        await db
          .select({ id: t.blogAuthors.id })
          .from(t.blogAuthors)
          .where(eq(t.blogAuthors.id, a.authorId))
      ).length
    )
      throw missing('author');
    if (
      a.categoryId &&
      !(
        await db
          .select({ id: t.blogCategories.id })
          .from(t.blogCategories)
          .where(eq(t.blogCategories.id, a.categoryId))
      ).length
    )
      throw missing('category');
    const tags = [...new Set(a.tagIds)];
    if (tags.length) {
      const found = await db
        .select({ id: t.blogTags.id })
        .from(t.blogTags)
        .where(inArray(t.blogTags.id, tags));
      if (found.length !== tags.length) throw missing('tag');
    }
    const media = [
      a.featuredMediaId,
      a.ogImageId,
      ...a.blocks.flatMap((b) => (b.type === 'image' ? [b.mediaId] : [])),
    ].filter((m): m is string => m !== null);
    const unique = [...new Set(media)];
    if (unique.length) {
      const found = await db
        .select({ id: t.blogMedia.id })
        .from(t.blogMedia)
        .where(and(inArray(t.blogMedia.id, unique), isNull(t.blogMedia.deletedAt)));
      if (found.length !== unique.length) throw missing('image');
    }
  }

  private async checkSlugFree(db: Db, slug: string, exceptId: string | null): Promise<void> {
    const problem = slugProblem(slug);
    if (problem) throw new VeyraError('INVALID_INPUT', problem, { field: 'slug' });
    const taken = await db
      .select({ id: t.blogArticles.id })
      .from(t.blogArticles)
      .where(
        exceptId
          ? and(eq(t.blogArticles.slug, slug), ne(t.blogArticles.id, exceptId))
          : eq(t.blogArticles.slug, slug),
      )
      .limit(1);
    if (taken.length)
      throw new VeyraError('CONFLICT', 'Another article already uses this URL slug.', {
        field: 'slug',
      });
  }

  private columns(a: BlogArticleInput) {
    const text = articleText(a.blocks, a.faq);
    return {
      title: a.title.trim(),
      slug: a.slug,
      excerpt: a.excerpt.trim(),
      bodyJson: JSON.stringify(a.blocks),
      faqJson: JSON.stringify(a.faq),
      authorId: a.authorId,
      categoryId: a.categoryId,
      seoTitle: a.seoTitle,
      metaDescription: a.metaDescription,
      canonicalUrl: a.canonicalUrl,
      noindex: a.noindex,
      ogTitle: a.ogTitle,
      ogDescription: a.ogDescription,
      ogImageId: a.ogImageId,
      twitterCard: a.twitterCard,
      focusKeyword: a.focusKeyword,
      featuredMediaId: a.featuredMediaId,
      featuredAlt: a.featuredAlt,
      cta: a.cta,
      searchText: `${a.title} ${a.excerpt} ${text}`.slice(0, 200_000),
      wordCount: wordCount(text),
    };
  }

  private async setTags(db: Db, articleId: string, tagIds: readonly string[]): Promise<void> {
    const wanted = [...new Set(tagIds)];
    await db.delete(t.blogArticleTags).where(
      wanted.length
        ? and(
            eq(t.blogArticleTags.articleId, articleId),
            sql`${t.blogArticleTags.tagId} NOT IN (${sql.join(
              wanted.map((w) => sql`${w}`),
              sql`, `,
            )})`,
          )
        : eq(t.blogArticleTags.articleId, articleId),
    );
    if (wanted.length)
      await db
        .insert(t.blogArticleTags)
        .values(wanted.map((tagId) => ({ articleId, tagId })))
        .onConflictDoNothing();
  }

  private async revision(
    db: Db,
    row: ArticleRow,
    input: BlogArticleInput,
    reason: string,
    userId: string | null,
  ) {
    await db
      .insert(t.blogRevisions)
      .values({
        id: ulid(),
        articleId: row.id,
        version: row.version,
        status: row.status,
        snapshotJson: JSON.stringify(input),
        reason,
        createdBy: userId,
        createdAt: this.now(),
      })
      .onConflictDoNothing();
  }

  private refuseUnpublishable(issues: readonly BlogIssue[], what: string): void {
    const blocking = blockingIssues(issues);
    if (blocking.length)
      throw new VeyraError(
        'INVALID_INPUT',
        `Fix ${blocking.length === 1 ? 'this' : `these ${blocking.length} things`} before ${what}: ${blocking[0]?.message ?? ''}`,
        {
          issues: blocking,
        },
      );
  }

  async create(raw: unknown, userId: string | null): Promise<ApiBlogArticle> {
    const input = BlogArticleInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.checkSlugFree(tx, input.slug, null);
      await this.checkReferences(tx, input);
      const now = this.now();
      const row = (
        await tx
          .insert(t.blogArticles)
          .values({
            id: ulid(),
            ...this.columns(input),
            status: 'DRAFT',
            version: 1,
            createdBy: userId,
            updatedBy: userId,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0];
      if (!row) throw new Error('insert returned nothing');
      await this.setTags(tx, row.id, input.tagIds);
      await this.revision(tx, row, input, 'Created', userId);
      await this.record(tx, 'article.created', userId, row.id, { title: row.title });
      return this.view(row, await this.tagIdsOf(tx, row.id));
    });
  }

  /**
   * Saves the whole article. A public article may only be saved in a publishable state (the
   * change is live at once); autosave is refused for it (half-written edits never go live).
   * Changing the slug of an article that was ever public leaves a permanent redirect behind.
   */
  async save(
    id: string,
    raw: unknown,
    baseVersion: number,
    autosave: boolean,
    userId: string,
  ): Promise<ApiBlogArticle> {
    const input = BlogArticleInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const before = await this.row(tx, id);
      if (before.version !== baseVersion)
        throw new VeyraError(
          'CONFLICT',
          `This article was changed elsewhere (now version ${before.version}). Reload it before saving.`,
          {
            version: before.version,
          },
        );
      const now = this.now();
      const live = isLive(before, now);
      const scheduled = before.status === 'SCHEDULED';
      if (autosave && (live || scheduled))
        throw new VeyraError(
          'INVALID_STATE',
          'Published and scheduled articles are saved by hand, never automatically.',
        );
      if (before.status === 'ARCHIVED')
        throw new VeyraError('INVALID_STATE', 'Move the article back to draft before editing it.');
      await this.checkSlugFree(tx, input.slug, id);
      await this.checkReferences(tx, input);
      if (live || scheduled)
        this.refuseUnpublishable(
          await this.checks(input),
          live ? 'updating a published article' : 'saving a scheduled article',
        );
      const updated = (
        await tx
          .update(t.blogArticles)
          .set({
            ...this.columns(input),
            version: before.version + 1,
            updatedBy: userId,
            updatedAt: now,
            ...(live ? { contentUpdatedAt: now } : {}),
          })
          .where(and(eq(t.blogArticles.id, id), eq(t.blogArticles.version, baseVersion)))
          .returning()
      )[0];
      if (!updated)
        throw new VeyraError(
          'CONFLICT',
          'This article was changed elsewhere. Reload it before saving.',
        );
      await this.setTags(tx, id, input.tagIds);
      if (before.slug !== updated.slug) {
        if (before.firstPublishedAt)
          await this.moveRedirects(
            tx,
            articlePath(before.slug),
            articlePath(updated.slug),
            id,
            userId,
          );
        await this.record(tx, 'article.slug_changed', userId, id, {
          from: before.slug,
          to: updated.slug,
          redirected: before.firstPublishedAt !== null,
        });
      }
      if (!autosave) {
        await this.revision(tx, updated, input, live ? 'Updated while published' : 'Saved', userId);
        await this.record(tx, 'article.updated', userId, id, { version: updated.version, live });
      }
      return this.view(updated, await this.tagIdsOf(tx, id));
    });
  }

  /** A redirect from `from` to `to`; older redirects to `from` now go straight to `to` (no chains). */
  private async moveRedirects(
    db: Db,
    from: string,
    to: string,
    articleId: string | null,
    userId: string | null,
  ) {
    const r = t.blogRedirects;
    const now = this.now();
    await db
      .update(r)
      .set({ removedAt: now })
      .where(and(eq(r.fromPath, to), isNull(r.removedAt)));
    await db
      .update(r)
      .set({ toPath: to })
      .where(and(eq(r.toPath, from), isNull(r.removedAt)));
    await db
      .update(r)
      .set({ removedAt: now })
      .where(and(isNull(r.removedAt), sql`${r.fromPath} = ${r.toPath}`));
    await db
      .update(r)
      .set({ removedAt: now })
      .where(and(eq(r.fromPath, from), isNull(r.removedAt)));
    await db.insert(r).values({
      id: ulid(),
      fromPath: from,
      toPath: to,
      articleId,
      createdBy: userId,
      createdAt: now,
    });
  }

  async changeStatus(
    id: string,
    to: BlogStatus,
    publishAt: string | null,
    baseVersion: number,
    userId: string,
  ): Promise<ApiBlogArticle> {
    return this.db.transaction(async (tx) => {
      const before = await this.row(tx, id);
      if (before.version !== baseVersion)
        throw new VeyraError('CONFLICT', 'This article was changed elsewhere. Reload it first.', {
          version: before.version,
        });
      const from = before.status as BlogStatus;
      if (from === to)
        throw new VeyraError(
          'INVALID_STATE',
          `The article is already ${to.toLowerCase().replace('_', ' ')}.`,
        );
      if (!canMoveBlog(from, to))
        throw new VeyraError('INVALID_STATE', `An article cannot move from ${from} to ${to}.`);
      const tagIds = await this.tagIdsOf(tx, id);
      const input = this.inputOf(before, tagIds);
      const now = this.now();
      const patch: Partial<typeof t.blogArticles.$inferInsert> = {
        status: to,
        version: before.version + 1,
        updatedBy: userId,
        updatedAt: now,
      };
      if (to === 'PUBLISHED' || to === 'SCHEDULED') {
        await this.checkReferences(tx, input);
        this.refuseUnpublishable(
          await this.checks(input),
          to === 'PUBLISHED' ? 'publishing' : 'scheduling',
        );
      }
      if (to === 'PUBLISHED') {
        // Republishing keeps the original publication date; a change since then shows as updated.
        patch.publishedAt =
          before.firstPublishedAt ??
          (from === 'SCHEDULED' && before.publishedAt && before.publishedAt <= now
            ? before.publishedAt
            : now);
        patch.firstPublishedAt = before.firstPublishedAt ?? patch.publishedAt;
        if (before.firstPublishedAt) patch.contentUpdatedAt = now;
      }
      if (to === 'SCHEDULED') {
        if (!publishAt)
          throw new VeyraError('INVALID_INPUT', 'Choose when the article goes live.', {
            field: 'publishAt',
          });
        const at = new Date(publishAt);
        if (Number.isNaN(at.getTime()) || at.getTime() <= this.clock().getTime() + 60_000)
          throw new VeyraError('INVALID_INPUT', 'Choose a time at least a minute from now.', {
            field: 'publishAt',
          });
        patch.publishedAt = at.toISOString();
      }
      const updated = (
        await tx
          .update(t.blogArticles)
          .set(patch)
          .where(and(eq(t.blogArticles.id, id), eq(t.blogArticles.version, baseVersion)))
          .returning()
      )[0];
      if (!updated)
        throw new VeyraError('CONFLICT', 'This article was changed elsewhere. Reload it first.');
      // The article's own address now belongs to it: an old redirect from there would hide it.
      if (to === 'PUBLISHED' || to === 'SCHEDULED')
        await tx
          .update(t.blogRedirects)
          .set({ removedAt: now })
          .where(
            and(
              eq(t.blogRedirects.fromPath, articlePath(updated.slug)),
              isNull(t.blogRedirects.removedAt),
            ),
          );
      await this.revision(tx, updated, input, `${from} → ${to}`, userId);
      await this.record(tx, 'article.status', userId, id, {
        from,
        to,
        ...(to === 'SCHEDULED' ? { publishAt: updated.publishedAt } : {}),
      });
      return this.view(updated, tagIds);
    });
  }

  /** Marks scheduled articles whose time has come as published (they are already public). */
  async promoteDue(): Promise<number> {
    const now = this.now();
    const due = await this.db
      .update(t.blogArticles)
      .set({ status: 'PUBLISHED', updatedAt: now, version: sql`${t.blogArticles.version} + 1` })
      .where(
        and(
          eq(t.blogArticles.status, 'SCHEDULED'),
          lte(t.blogArticles.publishedAt, now),
          isNull(t.blogArticles.deletedAt),
        ),
      )
      .returning();
    for (const row of due) {
      if (!row.firstPublishedAt)
        await this.db
          .update(t.blogArticles)
          .set({ firstPublishedAt: row.publishedAt })
          .where(eq(t.blogArticles.id, row.id));
      await this.record(this.db, 'article.status', null, row.id, {
        from: 'SCHEDULED',
        to: 'PUBLISHED',
        scheduled: true,
      });
    }
    return due.length;
  }

  async duplicate(id: string, userId: string): Promise<ApiBlogArticle> {
    const source = await this.get(id);
    let slug = `${source.slug}-copy`.slice(0, 74);
    for (
      let n = 2;
      (
        await this.db
          .select({ id: t.blogArticles.id })
          .from(t.blogArticles)
          .where(eq(t.blogArticles.slug, slug))
      ).length;
      n++
    )
      slug = `${source.slug.slice(0, 70)}-copy-${n}`;
    const created = await this.create(
      { ...source.article, title: `Copy of ${source.article.title}`.slice(0, 160), slug },
      userId,
    );
    await this.record(this.db, 'article.duplicated', userId, created.id, { from: id });
    return created;
  }

  /** Retires a draft that was never public (kept in the database, never shown again). */
  async remove(id: string, baseVersion: number, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.row(tx, id);
      if (row.version !== baseVersion)
        throw new VeyraError('CONFLICT', 'This article was changed elsewhere. Reload it first.');
      if (row.firstPublishedAt || row.status === 'PUBLISHED' || row.status === 'SCHEDULED')
        throw new VeyraError(
          'INVALID_STATE',
          'An article that has been public is archived, not deleted (its address answers "gone").',
        );
      const now = this.now();
      await tx
        .update(t.blogArticles)
        .set({
          deletedAt: now,
          slug: `${row.slug}--deleted-${row.id.toLowerCase()}`,
          updatedAt: now,
          updatedBy: userId,
        })
        .where(eq(t.blogArticles.id, id));
      await this.record(tx, 'article.deleted', userId, id, { slug: row.slug, title: row.title });
    });
  }

  async revisions(id: string): Promise<ApiBlogRevision[]> {
    await this.row(this.db, id);
    const rows = await this.db
      .select({ r: t.blogRevisions, name: t.users.name })
      .from(t.blogRevisions)
      .leftJoin(t.users, eq(t.users.id, t.blogRevisions.createdBy))
      .where(eq(t.blogRevisions.articleId, id))
      .orderBy(desc(t.blogRevisions.version))
      .limit(200);
    return rows.map(({ r, name }) => ({
      id: r.id,
      version: r.version,
      status: r.status as BlogStatus,
      reason: r.reason,
      createdAt: r.createdAt,
      createdBy: name,
      title: (JSON.parse(r.snapshotJson) as { title?: string }).title ?? '',
    }));
  }

  /** Puts a revision's content back as the article (a normal save: same checks, new version). */
  async restore(
    id: string,
    revisionId: string,
    baseVersion: number,
    userId: string,
  ): Promise<ApiBlogArticle> {
    const rev = (
      await this.db
        .select()
        .from(t.blogRevisions)
        .where(and(eq(t.blogRevisions.id, revisionId), eq(t.blogRevisions.articleId, id)))
        .limit(1)
    )[0];
    if (!rev) throw new VeyraError('NOT_FOUND', 'Revision not found.');
    const restored = await this.save(id, JSON.parse(rev.snapshotJson), baseVersion, false, userId);
    await this.record(this.db, 'article.restored', userId, id, { fromVersion: rev.version });
    return restored;
  }

  // ── Taxonomy and authors ──────────────────────────────────────────────────

  private async counts(column: typeof t.blogArticles.categoryId | typeof t.blogArticles.authorId) {
    const rows = await this.db
      .select({ id: column, n: sql<number>`count(*)::int` })
      .from(t.blogArticles)
      .where(and(isNull(t.blogArticles.deletedAt), isNotNull(column)))
      .groupBy(column);
    return new Map(rows.map((r) => [r.id ?? '', r.n]));
  }

  async categories(): Promise<ApiBlogTerm[]> {
    const n = await this.counts(t.blogArticles.categoryId);
    const rows = await this.db
      .select()
      .from(t.blogCategories)
      .orderBy(asc(t.blogCategories.position), asc(t.blogCategories.name));
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      articles: n.get(c.id) ?? 0,
    }));
  }

  async tags(): Promise<ApiBlogTerm[]> {
    const rows = await this.db
      .select({ tag: t.blogTags, n: sql<number>`count(${t.blogArticleTags.articleId})::int` })
      .from(t.blogTags)
      .leftJoin(t.blogArticleTags, eq(t.blogArticleTags.tagId, t.blogTags.id))
      .groupBy(t.blogTags.id)
      .orderBy(asc(t.blogTags.name));
    return rows.map(({ tag, n }) => ({
      id: tag.id,
      name: tag.name,
      slug: tag.slug,
      description: tag.description,
      articles: n,
    }));
  }

  async authors(): Promise<ApiBlogAuthor[]> {
    const n = await this.counts(t.blogArticles.authorId);
    const rows = await this.db.select().from(t.blogAuthors).orderBy(asc(t.blogAuthors.name));
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      role: a.roleTitle,
      bio: a.bio,
      articles: n.get(a.id) ?? 0,
    }));
  }

  private async termWrite(
    table: typeof t.blogCategories | typeof t.blogTags,
    id: string | null,
    v: { name: string; slug: string; description?: string | undefined },
    userId: string | null,
  ): Promise<string> {
    const problem = slugProblem(v.slug);
    if (problem) throw new VeyraError('INVALID_INPUT', problem, { field: 'slug' });
    if (!v.name.trim()) throw new VeyraError('INVALID_INPUT', 'Enter a name.', { field: 'name' });
    const clash = await this.db
      .select({ id: table.id })
      .from(table)
      .where(id ? and(eq(table.slug, v.slug), ne(table.id, id)) : eq(table.slug, v.slug));
    if (clash.length)
      throw new VeyraError('CONFLICT', 'That slug is already used.', { field: 'slug' });
    const now = this.now();
    const values = {
      name: v.name.trim(),
      slug: v.slug,
      description: v.description?.trim() ?? '',
      updatedAt: now,
    };
    let finalId = id;
    if (id) {
      const done = await this.db
        .update(table)
        .set(values)
        .where(eq(table.id, id))
        .returning({ id: table.id });
      if (!done.length) throw new VeyraError('NOT_FOUND', 'Not found.');
    } else {
      finalId = ulid();
      await this.db.insert(table).values({ id: finalId, ...values, createdAt: now });
    }
    await this.record(this.db, 'taxonomy.changed', userId, null, {
      kind: table === t.blogCategories ? 'category' : 'tag',
      id: finalId,
      slug: v.slug,
    });
    return finalId ?? '';
  }

  saveCategory(
    id: string | null,
    v: { name: string; slug: string; description?: string | undefined },
    userId: string | null,
  ) {
    return this.termWrite(t.blogCategories, id, v, userId);
  }
  saveTag(
    id: string | null,
    v: { name: string; slug: string; description?: string | undefined },
    userId: string | null,
  ) {
    return this.termWrite(t.blogTags, id, v, userId);
  }

  async saveAuthor(
    id: string | null,
    v: { name: string; slug: string; role?: string | undefined; bio?: string | undefined },
    userId: string | null,
  ): Promise<string> {
    const problem = slugProblem(v.slug);
    if (problem) throw new VeyraError('INVALID_INPUT', problem, { field: 'slug' });
    if (!v.name.trim()) throw new VeyraError('INVALID_INPUT', 'Enter a name.', { field: 'name' });
    const a = t.blogAuthors;
    const clash = await this.db
      .select({ id: a.id })
      .from(a)
      .where(id ? and(eq(a.slug, v.slug), ne(a.id, id)) : eq(a.slug, v.slug));
    if (clash.length)
      throw new VeyraError('CONFLICT', 'That slug is already used.', { field: 'slug' });
    const now = this.now();
    const values = {
      name: v.name.trim(),
      slug: v.slug,
      roleTitle: v.role?.trim() ?? '',
      bio: v.bio?.trim() ?? '',
      updatedAt: now,
    };
    let finalId = id;
    if (id) {
      const done = await this.db.update(a).set(values).where(eq(a.id, id)).returning({ id: a.id });
      if (!done.length) throw new VeyraError('NOT_FOUND', 'Author not found.');
    } else {
      finalId = ulid();
      await this.db.insert(a).values({ id: finalId, ...values, createdAt: now });
    }
    await this.record(this.db, 'author.changed', userId, null, { id: finalId, slug: v.slug });
    return finalId ?? '';
  }

  // ── Media ────────────────────────────────────────────────────────────────

  private mediaView(
    m: Pick<
      typeof t.blogMedia.$inferSelect,
      'id' | 'width' | 'height' | 'bytes' | 'alt' | 'createdAt'
    >,
  ): ApiBlogMedia {
    return {
      id: m.id,
      url: `/blog/media/${m.id}.webp`,
      width: m.width,
      height: m.height,
      bytes: m.bytes,
      alt: m.alt,
      createdAt: m.createdAt,
    };
  }

  async upload(bytes: Uint8Array, alt: string, userId: string): Promise<ApiBlogMedia> {
    const img = await processImage(bytes);
    const m = t.blogMedia;
    const existing = (await this.db.select().from(m).where(eq(m.sha256, img.sha256)).limit(1))[0];
    if (existing && !existing.deletedAt) return this.mediaView(existing);
    const now = this.now();
    const values = {
      mime: img.mime,
      body: img.body,
      width: img.width,
      height: img.height,
      bytes: img.body.byteLength,
      smallBody: img.small?.body ?? null,
      smallWidth: img.small?.width ?? null,
      sha256: img.sha256,
      alt: alt.trim().slice(0, 300),
      createdBy: userId,
      createdAt: now,
      deletedAt: null,
    };
    const id = existing?.id ?? ulid();
    if (existing) await this.db.update(m).set(values).where(eq(m.id, id));
    else await this.db.insert(m).values({ id, ...values });
    await this.record(this.db, 'media.uploaded', userId, null, {
      id,
      width: img.width,
      height: img.height,
      bytes: img.body.byteLength,
    });
    return this.mediaView({ id, ...values });
  }

  async media(): Promise<ApiBlogMedia[]> {
    const m = t.blogMedia;
    const rows = await this.db
      .select({
        id: m.id,
        width: m.width,
        height: m.height,
        bytes: m.bytes,
        alt: m.alt,
        createdAt: m.createdAt,
      })
      .from(m)
      .where(isNull(m.deletedAt))
      .orderBy(desc(m.seq))
      .limit(500);
    return rows.map((r) => this.mediaView(r));
  }

  async setMediaAlt(id: string, alt: string, userId: string): Promise<void> {
    const done = await this.db
      .update(t.blogMedia)
      .set({ alt: alt.trim().slice(0, 300) })
      .where(and(eq(t.blogMedia.id, id), isNull(t.blogMedia.deletedAt)))
      .returning({ id: t.blogMedia.id });
    if (!done.length) throw new VeyraError('NOT_FOUND', 'Image not found.');
    await this.record(this.db, 'media.uploaded', userId, null, { id, alt: true });
  }

  /** Retires an image no article uses: no longer served, its bytes cleared. */
  async retireMedia(id: string, userId: string): Promise<void> {
    const a = t.blogArticles;
    const used = await this.db
      .select({ id: a.id, title: a.title })
      .from(a)
      .where(
        and(
          isNull(a.deletedAt),
          or(
            eq(a.featuredMediaId, id),
            eq(a.ogImageId, id),
            sql`${a.bodyJson} LIKE ${`%"mediaId":"${id}"%`}`,
          ),
        ),
      )
      .limit(1);
    if (used[0])
      throw new VeyraError(
        'INVALID_STATE',
        `This image is used by “${used[0].title}”. Remove it there first.`,
      );
    const done = await this.db
      .update(t.blogMedia)
      .set({ deletedAt: this.now(), body: Buffer.alloc(0), smallBody: null })
      .where(and(eq(t.blogMedia.id, id), isNull(t.blogMedia.deletedAt)))
      .returning({ id: t.blogMedia.id });
    if (!done.length) throw new VeyraError('NOT_FOUND', 'Image not found.');
    await this.record(this.db, 'media.deleted', userId, null, { id });
  }

  /** The image's bytes for the public (null: no such image, or retired). */
  async mediaFile(id: string, small: boolean): Promise<{ body: Buffer; mime: string } | null> {
    const m = t.blogMedia;
    const row = (
      await this.db
        .select({
          body: small ? sql<Buffer>`coalesce(${m.smallBody}, ${m.body})` : m.body,
          mime: m.mime,
        })
        .from(m)
        .where(and(eq(m.id, id), isNull(m.deletedAt)))
        .limit(1)
    )[0];
    if (!row) return null;
    return {
      body: Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body as unknown as Uint8Array),
      mime: row.mime,
    };
  }

  async mediaInfo(
    ids: readonly string[],
  ): Promise<
    Map<string, { width: number; height: number; smallWidth: number | null; alt: string }>
  > {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const m = t.blogMedia;
    const rows = await this.db
      .select({ id: m.id, width: m.width, height: m.height, smallWidth: m.smallWidth, alt: m.alt })
      .from(m)
      .where(and(inArray(m.id, unique), isNull(m.deletedAt)));
    return new Map(rows.map((r) => [r.id, r]));
  }

  // ── Redirects ────────────────────────────────────────────────────────────

  async redirects(): Promise<ApiBlogRedirect[]> {
    const r = t.blogRedirects;
    const rows = await this.db
      .select()
      .from(r)
      .where(isNull(r.removedAt))
      .orderBy(desc(r.seq))
      .limit(1000);
    return rows.map((x) => ({
      id: x.id,
      fromPath: x.fromPath,
      toPath: x.toPath,
      createdAt: x.createdAt,
      hits: x.hits,
    }));
  }

  async addRedirect(fromPath: string, toPath: string, userId: string): Promise<void> {
    const path = /^\/(?!\/)[A-Za-z0-9._~\-/]{0,299}$/;
    const from = fromPath.trim().replace(/\/+$/, '');
    const to = toPath.trim().replace(/(.)\/+$/, '$1');
    if (!path.test(from) || !from.startsWith('/blog/'))
      throw new VeyraError('INVALID_INPUT', 'Redirect from a /blog/… path on this site.', {
        field: 'fromPath',
      });
    if (!path.test(to))
      throw new VeyraError(
        'INVALID_INPUT',
        'Redirect to a path on this site, such as /blog/new-article.',
        { field: 'toPath' },
      );
    if (from === to) throw new VeyraError('INVALID_INPUT', 'A path cannot redirect to itself.');
    const live = await this.db
      .select({ id: t.blogArticles.id })
      .from(t.blogArticles)
      .where(and(eq(t.blogArticles.slug, from.slice('/blog/'.length)), this.livePredicate()));
    if (live.length)
      throw new VeyraError('CONFLICT', 'A published article lives at that path.', {
        field: 'fromPath',
      });
    await this.db.transaction(async (tx) => {
      const target = await tx
        .select({ to: t.blogRedirects.toPath })
        .from(t.blogRedirects)
        .where(and(eq(t.blogRedirects.fromPath, to), isNull(t.blogRedirects.removedAt)));
      if (target[0]?.to === from)
        throw new VeyraError('INVALID_INPUT', 'That would make a redirect loop.');
      await this.moveRedirects(tx, from, target[0]?.to ?? to, null, userId);
      await this.record(tx, 'redirect.changed', userId, null, { from, to });
    });
  }

  async removeRedirect(id: string, userId: string): Promise<void> {
    const done = await this.db
      .update(t.blogRedirects)
      .set({ removedAt: this.now() })
      .where(and(eq(t.blogRedirects.id, id), isNull(t.blogRedirects.removedAt)))
      .returning({ from: t.blogRedirects.fromPath });
    if (!done[0]) throw new VeyraError('NOT_FOUND', 'Redirect not found.');
    await this.record(this.db, 'redirect.changed', userId, null, { removed: done[0].from });
  }

  async resolveRedirect(path: string): Promise<string | null> {
    const r = t.blogRedirects;
    const row = (
      await this.db
        .update(r)
        .set({ hits: sql`${r.hits} + 1` })
        .where(and(eq(r.fromPath, path), isNull(r.removedAt)))
        .returning({ to: r.toPath })
    )[0];
    return row?.to ?? null;
  }

  // ── Public reading ───────────────────────────────────────────────────────

  private cardSelect() {
    const a = t.blogArticles;
    return this.db
      .select({
        id: a.id,
        slug: a.slug,
        title: a.title,
        excerpt: a.excerpt,
        publishedAt: a.publishedAt,
        contentUpdatedAt: a.contentUpdatedAt,
        wordCount: a.wordCount,
        featuredMediaId: a.featuredMediaId,
        featuredAlt: a.featuredAlt,
        authorName: t.blogAuthors.name,
        authorSlug: t.blogAuthors.slug,
        categoryName: t.blogCategories.name,
        categorySlug: t.blogCategories.slug,
      })
      .from(a)
      .leftJoin(t.blogAuthors, eq(t.blogAuthors.id, a.authorId))
      .leftJoin(t.blogCategories, eq(t.blogCategories.id, a.categoryId));
  }

  private toCard(
    r: Awaited<ReturnType<ReturnType<BlogService['cardSelect']>['execute']>>[number],
  ): ArticleCard {
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      excerpt: r.excerpt,
      publishedAt: r.publishedAt ?? '',
      contentUpdatedAt: r.contentUpdatedAt,
      wordCount: r.wordCount,
      featuredMediaId: r.featuredMediaId,
      featuredAlt: r.featuredAlt,
      author: r.authorName && r.authorSlug ? { name: r.authorName, slug: r.authorSlug } : null,
      category:
        r.categoryName && r.categorySlug ? { name: r.categoryName, slug: r.categorySlug } : null,
    };
  }

  /** A page of public articles, newest first; optionally one category's or one tag's. */
  async publicPage(o: {
    page: number;
    categoryId?: string;
    tagId?: string;
    pageSize?: number;
  }): Promise<{ items: ArticleCard[]; total: number }> {
    const a = t.blogArticles;
    const size = o.pageSize ?? 12;
    const where: SQL[] = [this.livePredicate()];
    if (o.categoryId) where.push(eq(a.categoryId, o.categoryId));
    if (o.tagId)
      where.push(
        sql`${a.id} IN (SELECT ${t.blogArticleTags.articleId} FROM ${t.blogArticleTags} WHERE ${t.blogArticleTags.tagId} = ${o.tagId})`,
      );
    const total =
      (
        await this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(a)
          .where(and(...where))
      )[0]?.n ?? 0;
    const rows = await this.cardSelect()
      .where(and(...where))
      .orderBy(desc(a.publishedAt), desc(a.seq))
      .limit(size)
      .offset((Math.max(1, o.page) - 1) * size);
    return { items: rows.map((r) => this.toCard(r)), total };
  }

  async search(
    q: string,
    page: number,
    pageSize = 12,
  ): Promise<{ items: ArticleCard[]; total: number }> {
    const a = t.blogArticles;
    const doc = sql`to_tsvector('english', ${a.title} || ' ' || ${a.searchText})`;
    const query = sql`websearch_to_tsquery('english', ${q})`;
    const where = and(this.livePredicate(), sql`${doc} @@ ${query}`);
    const total =
      (
        await this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(a)
          .where(where)
      )[0]?.n ?? 0;
    const rows = await this.cardSelect()
      .where(where)
      .orderBy(desc(sql`ts_rank(${doc}, ${query})`), desc(a.publishedAt))
      .limit(pageSize)
      .offset((Math.max(1, page) - 1) * pageSize);
    return { items: rows.map((r) => this.toCard(r)), total };
  }

  /** A public article by slug, with its author, category and tags; null if not public. */
  async publicArticle(slug: string): Promise<PublicArticle | null> {
    const row = (
      await this.db
        .select()
        .from(t.blogArticles)
        .where(and(eq(t.blogArticles.slug, slug), this.livePredicate()))
        .limit(1)
    )[0];
    return row ? this.withRelations(row) : null;
  }

  /** Any article by id (preview for signed-in editors only). */
  async previewArticle(id: string): Promise<PublicArticle> {
    return this.withRelations(await this.row(this.db, id));
  }

  private async withRelations(row: ArticleRow): Promise<PublicArticle> {
    const [author, category, tags] = await Promise.all([
      row.authorId
        ? this.db
            .select()
            .from(t.blogAuthors)
            .where(eq(t.blogAuthors.id, row.authorId))
            .then((r) => r[0] ?? null)
        : null,
      row.categoryId
        ? this.db
            .select()
            .from(t.blogCategories)
            .where(eq(t.blogCategories.id, row.categoryId))
            .then((r) => r[0] ?? null)
        : null,
      this.db
        .select({ tag: t.blogTags })
        .from(t.blogArticleTags)
        .innerJoin(t.blogTags, eq(t.blogTags.id, t.blogArticleTags.tagId))
        .where(eq(t.blogArticleTags.articleId, row.id))
        .orderBy(asc(t.blogTags.name))
        .then((r) => r.map((x) => x.tag)),
    ]);
    return {
      row,
      blocks: parseBlocks(row.bodyJson),
      faq: parseFaq(row.faqJson),
      author,
      category,
      tags,
    };
  }

  /** Whether a slug belonged to an article that was public and has been archived (410 Gone). */
  async gone(slug: string): Promise<boolean> {
    const a = t.blogArticles;
    const row = await this.db
      .select({ id: a.id })
      .from(a)
      .where(
        and(
          eq(a.slug, slug),
          eq(a.status, 'ARCHIVED'),
          isNotNull(a.firstPublishedAt),
          isNull(a.deletedAt),
        ),
      )
      .limit(1);
    return row.length > 0;
  }

  /** Up to three other public articles: same category first, then shared tags, then newest. */
  async related(article: PublicArticle, limit = 3): Promise<ArticleCard[]> {
    const a = t.blogArticles;
    const tagIds = article.tags.map((x) => x.id);
    const score = sql<number>`(CASE WHEN ${a.categoryId} = ${article.row.categoryId ?? ''} THEN 2 ELSE 0 END) + ${
      tagIds.length
        ? sql`(SELECT count(*) FROM ${t.blogArticleTags} WHERE ${t.blogArticleTags.articleId} = ${a.id} AND ${t.blogArticleTags.tagId} IN (${sql.join(
            tagIds.map((x) => sql`${x}`),
            sql`, `,
          )}))`
        : sql`0`
    }`;
    const rows = await this.cardSelect()
      .where(and(this.livePredicate(), ne(a.id, article.row.id)))
      .orderBy(desc(score), desc(a.publishedAt))
      .limit(limit);
    return rows.map((r) => this.toCard(r));
  }

  async categoryBySlug(slug: string) {
    return (
      (
        await this.db
          .select()
          .from(t.blogCategories)
          .where(eq(t.blogCategories.slug, slug))
          .limit(1)
      )[0] ?? null
    );
  }
  async tagBySlug(slug: string) {
    return (
      (await this.db.select().from(t.blogTags).where(eq(t.blogTags.slug, slug)).limit(1))[0] ?? null
    );
  }

  /** Categories that have at least one public article (navigation and sitemap). */
  async publicCategories(): Promise<
    {
      id: string;
      name: string;
      slug: string;
      description: string;
      articles: number;
      lastmod: string;
    }[]
  > {
    const a = t.blogArticles;
    const c = t.blogCategories;
    return this.db
      .select({
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        articles: sql<number>`count(${a.id})::int`,
        lastmod: sql<string>`max(coalesce(${a.contentUpdatedAt}, ${a.publishedAt}))`,
      })
      .from(c)
      .innerJoin(a, and(eq(a.categoryId, c.id), this.livePredicate()))
      .groupBy(c.id)
      .orderBy(asc(c.position), asc(c.name))
      .then((rows) => rows.map((r) => ({ ...r, lastmod: t.toIsoTimestamp(r.lastmod) })));
  }

  /** Public, indexable, self-canonical articles (the sitemap). */
  async sitemapArticles(): Promise<{ slug: string; lastmod: string }[]> {
    const a = t.blogArticles;
    const rows = await this.db
      .select({ slug: a.slug, publishedAt: a.publishedAt, updated: a.contentUpdatedAt })
      .from(a)
      .where(and(this.livePredicate(), eq(a.noindex, false), isNull(a.canonicalUrl)))
      .orderBy(desc(a.publishedAt));
    return rows.map((r) => ({ slug: r.slug, lastmod: r.updated ?? r.publishedAt ?? this.now() }));
  }

  /** Public page paths on the site (internal-link checks). */
  async knownPaths(): Promise<Set<string>> {
    const a = t.blogArticles;
    const articles = await this.db.select({ slug: a.slug }).from(a).where(this.livePredicate());
    const cats = await this.publicCategories();
    const tags = await this.db.select({ slug: t.blogTags.slug }).from(t.blogTags);
    return new Set([
      '/',
      '/blog',
      '/blog/search',
      '/5-invoice-challenge',
      ...articles.map((r) => articlePath(r.slug)),
      ...cats.map((c) => `/blog/category/${c.slug}`),
      ...tags.map((x) => `/blog/tag/${x.slug}`),
    ]);
  }
}
