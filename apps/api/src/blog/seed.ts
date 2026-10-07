import { eq } from 'drizzle-orm';
import type { BlogArticleInput } from '@veyra/shared';
import * as t from '../db/schema';
import { BLOG_ARTICLES } from './articles';
import type { BlogService } from './service';

/**
 * The blog's starting content: six categories, one author byline, and eight complete articles
 * (./articles.ts), created as DRAFTS. Nothing reaches readers until an editor reads an article
 * and publishes it from the studio. Running it again changes nothing that already exists
 * (matched by slug).
 */
export const BLOG_CATEGORIES = [
  {
    slug: 'invoice-verification',
    name: 'Invoice Verification',
    description: 'Checking supplier invoices before they are approved for payment.',
  },
  {
    slug: 'accounts-payable-automation',
    name: 'Accounts Payable Automation',
    description: 'What automation can and cannot do in accounts payable.',
  },
  {
    slug: 'purchase-orders-grn-reconciliation',
    name: 'Purchase Orders and GRN Reconciliation',
    description: 'Matching invoices with purchase orders and goods receipts.',
  },
  {
    slug: 'gst-invoice-accuracy',
    name: 'GST and Invoice Accuracy',
    description: 'GSTINs, tax heads and arithmetic on Indian supplier invoices.',
  },
  {
    slug: 'duplicate-invoices-fraud-prevention',
    name: 'Duplicate Invoices and Fraud Prevention',
    description: 'Catching duplicate and suspicious invoices before payment.',
  },
  {
    slug: 'finance-operations',
    name: 'Finance Operations',
    description: 'Running the finance and accounts team day to day.',
  },
] as const;

export const BLOG_DEFAULT_AUTHOR = {
  slug: 'veyrafy-team',
  name: 'Veyrafy Team',
  role: 'Veyrafy',
  bio: 'The team building Veyrafy, which checks supplier invoices against accounting records before payment.',
};

/** Creates what is missing (idempotent). Returns how many things were created. */
export async function seedBlog(
  blog: BlogService,
): Promise<{ categories: number; authors: number; articles: number }> {
  const created = { categories: 0, authors: 0, articles: 0 };
  const categories = new Map((await blog.categories()).map((c) => [c.slug, c.id]));
  for (const [i, c] of BLOG_CATEGORIES.entries()) {
    if (categories.has(c.slug)) continue;
    const id = await blog.saveCategory(null, c, null);
    await blog.db.update(t.blogCategories).set({ position: i }).where(eq(t.blogCategories.id, id));
    categories.set(c.slug, id);
    created.categories++;
  }
  let author = (await blog.authors()).find((a) => a.slug === BLOG_DEFAULT_AUTHOR.slug)?.id;
  if (!author) {
    author = await blog.saveAuthor(null, BLOG_DEFAULT_AUTHOR, null);
    created.authors++;
  }
  for (const o of BLOG_ARTICLES) {
    const exists = await blog.db
      .select({ id: t.blogArticles.id })
      .from(t.blogArticles)
      .where(eq(t.blogArticles.slug, o.slug))
      .limit(1);
    if (exists.length) continue;
    const input: BlogArticleInput = {
      title: o.title,
      slug: o.slug,
      excerpt: o.excerpt,
      blocks: [...o.blocks],
      faq: [...o.faq],
      authorId: author,
      categoryId: categories.get(o.category) ?? null,
      tagIds: [],
      seoTitle: o.seoTitle,
      metaDescription: o.metaDescription,
      canonicalUrl: null,
      noindex: false,
      ogTitle: null,
      ogDescription: null,
      ogImageId: null,
      twitterCard: 'summary_large_image',
      focusKeyword: o.focusKeyword,
      featuredMediaId: null,
      featuredAlt: null,
      cta: 'challenge',
    };
    await blog.create(input, null);
    created.articles++;
  }
  return created;
}
