import { z } from 'zod';
import {
  BLOG_CTAS,
  BLOG_LIMITS as L,
  BLOG_STATUSES,
  SLUG_MAX,
  TWITTER_CARDS,
  type BlogBlock,
} from '../blog';

/** The blog's API contracts (publishing studio ↔ server). Every request body is parsed with these. */

const text = (max: number) => z.string().max(max);
const line = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.replace(/[\r\n]+/g, ' '));
const Id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Not an id.');
const Slug = z.string().max(SLUG_MAX);

export const BlogBlockSchema: z.ZodType<BlogBlock> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: text(L.blockText) }).strict(),
  z
    .object({
      type: z.literal('heading'),
      level: z.union([z.literal(2), z.literal(3)]),
      text: line(200),
    })
    .strict(),
  z
    .object({
      type: z.literal('list'),
      ordered: z.boolean(),
      items: z.array(text(2000)).min(1).max(L.listItems),
    })
    .strict(),
  z.object({ type: z.literal('quote'), text: text(2000), cite: line(200).optional() }).strict(),
  z
    .object({
      type: z.literal('image'),
      mediaId: Id,
      alt: line(300),
      caption: line(400).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      caption: line(300).optional(),
      header: z.array(line(200)).min(1).max(L.tableColumns),
      rows: z.array(z.array(text(1000)).max(L.tableColumns)).max(L.tableRows),
    })
    .strict()
    .refine((t) => t.rows.every((r) => r.length === t.header.length), {
      message: 'Every table row needs one cell per column.',
    }),
  z
    .object({
      type: z.literal('callout'),
      tone: z.enum(['info', 'tip', 'warning']),
      text: text(2000),
    })
    .strict(),
  z.object({ type: z.literal('note'), text: text(L.blockText) }).strict(),
]);

export const BlogFaqSchema = z.object({ q: line(300), a: text(3000) }).strict();

const nullableLine = (max: number) =>
  line(max)
    .nullable()
    .transform((s) => (s === null || s.trim() === '' ? null : s.trim()));

/** An article as the studio sends it (create, or the full article on save). */
export const BlogArticleInputSchema = z
  .object({
    title: line(L.title),
    slug: Slug,
    excerpt: text(L.excerpt),
    blocks: z.array(BlogBlockSchema).max(L.blocks),
    faq: z.array(BlogFaqSchema).max(L.faq),
    authorId: Id.nullable(),
    categoryId: Id.nullable(),
    tagIds: z.array(Id).max(20),
    seoTitle: nullableLine(L.seoTitle),
    metaDescription: nullableLine(L.metaDescription),
    canonicalUrl: nullableLine(500),
    noindex: z.boolean(),
    ogTitle: nullableLine(L.seoTitle),
    ogDescription: nullableLine(L.metaDescription),
    ogImageId: Id.nullable(),
    twitterCard: z.enum(TWITTER_CARDS),
    focusKeyword: nullableLine(120),
    featuredMediaId: Id.nullable(),
    featuredAlt: nullableLine(300),
    cta: z.enum(BLOG_CTAS),
  })
  .strict();
export type BlogArticleInput = z.output<typeof BlogArticleInputSchema>;

/** A save: the article and the version it was edited from (a newer one is never overwritten). */
export const BlogSaveSchema = z
  .object({
    article: BlogArticleInputSchema,
    baseVersion: z.number().int().min(1),
    autosave: z.boolean(),
  })
  .strict();

export const BlogStatusChangeSchema = z
  .object({
    to: z.enum(BLOG_STATUSES),
    /** SCHEDULED: when it goes live (ISO, in the future). PUBLISHED: optional backdate is refused. */
    publishAt: z.string().datetime({ offset: true }).nullable().optional(),
    baseVersion: z.number().int().min(1),
  })
  .strict();

export const BlogTaxonomyInputSchema = z
  .object({ name: line(80), slug: Slug, description: text(400).optional() })
  .strict();

export const BlogAuthorInputSchema = z
  .object({ name: line(120), slug: Slug, role: line(120).optional(), bio: text(600).optional() })
  .strict();

export const BlogRedirectInputSchema = z
  .object({ fromPath: line(300), toPath: line(300) })
  .strict();

// ── Responses ────────────────────────────────────────────────────────────────

export const ApiBlogMediaSchema = z.object({
  id: Id,
  url: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  alt: z.string(),
  createdAt: z.string(),
});
export type ApiBlogMedia = z.infer<typeof ApiBlogMediaSchema>;

export const ApiBlogTermSchema = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  articles: z.number().int(),
});
export type ApiBlogTerm = z.infer<typeof ApiBlogTermSchema>;

export const ApiBlogAuthorSchema = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  role: z.string(),
  bio: z.string(),
  articles: z.number().int(),
});
export type ApiBlogAuthor = z.infer<typeof ApiBlogAuthorSchema>;

export const ApiBlogSummarySchema = z.object({
  id: Id,
  title: z.string(),
  slug: z.string(),
  status: z.enum(BLOG_STATUSES),
  authorId: z.string().nullable(),
  categoryId: z.string().nullable(),
  publishedAt: z.string().nullable(),
  updatedAt: z.string(),
  createdAt: z.string(),
  version: z.number().int(),
  /** Whether it is readable at its public address right now. */
  live: z.boolean(),
  /** Editorial notes left in the body (an outline is not publishable). */
  notes: z.number().int(),
});
export type ApiBlogSummary = z.infer<typeof ApiBlogSummarySchema>;

export const ApiBlogArticleSchema = ApiBlogSummarySchema.extend({
  article: BlogArticleInputSchema,
  firstPublishedAt: z.string().nullable(),
  contentUpdatedAt: z.string().nullable(),
  publicUrl: z.string(),
  previewUrl: z.string(),
});
export type ApiBlogArticle = z.infer<typeof ApiBlogArticleSchema>;

export const ApiBlogRevisionSchema = z.object({
  id: Id,
  version: z.number().int(),
  status: z.enum(BLOG_STATUSES),
  reason: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  title: z.string(),
});
export type ApiBlogRevision = z.infer<typeof ApiBlogRevisionSchema>;

export const ApiBlogRedirectSchema = z.object({
  id: Id,
  fromPath: z.string(),
  toPath: z.string(),
  createdAt: z.string(),
  hits: z.number().int(),
});
export type ApiBlogRedirect = z.infer<typeof ApiBlogRedirectSchema>;

export const ApiBlogEventSchema = z.object({
  id: Id,
  event: z.string(),
  articleId: z.string().nullable(),
  userName: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type ApiBlogEvent = z.infer<typeof ApiBlogEventSchema>;
