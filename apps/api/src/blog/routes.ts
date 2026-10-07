import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiBlogArticleSchema,
  ApiBlogAuthorSchema,
  ApiBlogEventSchema,
  ApiBlogMediaSchema,
  ApiBlogRedirectSchema,
  ApiBlogRevisionSchema,
  ApiBlogSummarySchema,
  ApiBlogTermSchema,
  BLOG_LIMITS,
  BLOG_STATUSES,
  BlogArticleInputSchema,
  BlogAuthorInputSchema,
  BlogRedirectInputSchema,
  BlogSaveSchema,
  BlogStatusChangeSchema,
  BlogTaxonomyInputSchema,
  SLUG_PATTERN,
  type BlogBlock,
} from '@veyra/shared';
import { actorOf, requirePermission } from '../http/access';
import type { RateLimiter } from '../http/rate-limit';
import { contentSecurityPolicy } from '@veyra/web/security-headers';
import { VeyraError } from '../workflow/veyra';
import type { BlogAssets } from './assets';
import {
  archivePage,
  articlePage,
  blogIndexPage,
  messagePage,
  rssXml,
  searchPage,
  sitemapXml,
  usesAnalytics,
  type RenderContext,
} from './render';
import type { ArticleCard, BlogService, PublicArticle } from './service';

/**
 * The blog's HTTP surface on the website (veyrafy.com):
 * - public pages, rendered on the server (/blog…, /sitemap.xml, /blog/feed.xml, /blog/media/…);
 * - the studio's API (/api/v1/blog/…), for signed-in Veyrafy editors only, each route declaring the
 *   permission it needs (blog.view, blog.write, blog.publish). The access hook enforces it before
 *   anything is read; hiding a button in the studio is never the protection.
 */
export interface BlogRouteOptions {
  blog: BlogService;
  assets: BlogAssets;
  /** The site's public origin (canonical URLs). */
  origin: string;
  ga4: string | null;
  gscVerification: string | null;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

export const CONSENT_COOKIE = 'veyrafy_analytics';
const PUBLIC = { config: { access: 'public' } } as const;
const may = (access: 'blog.view' | 'blog.write' | 'blog.publish') => ({ config: { access } });
const Id = z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });
const SlugParam = z.object({ slug: z.string().max(120) });
const PageParam = z.object({
  n: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number),
});

/** Google's documented hosts for GA4, allowed only on pages that load it (after consent). */
const GA_CSP = {
  script: 'https://www.googletagmanager.com',
  connect:
    'https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com',
  img: 'https://*.google-analytics.com https://*.googletagmanager.com',
};

function pageCsp(analytics: boolean): string {
  const base = contentSecurityPolicy();
  if (!analytics) return base;
  return base
    .replace("script-src 'self'", `script-src 'self' ${GA_CSP.script}`)
    .replace("connect-src 'self'", `connect-src 'self' ${GA_CSP.connect}`)
    .replace("img-src 'self' data:", `img-src 'self' data: ${GA_CSP.img}`);
}

export function registerBlogRoutes(app: FastifyInstance, o: BlogRouteOptions): void {
  const { blog, assets, origin, limiter } = o;
  const pageSize = BLOG_LIMITS.pageSize;

  // An HTML form (the analytics choice) posts urlencoded fields; nothing else uses this type.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 2048 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );

  // /blog/x/ and /blog/ → the address without the slash (one canonical form per page).
  app.addHook('onRequest', async (req, reply) => {
    const [path, query] = (req.url ?? '').split('?') as [string, string | undefined];
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      path.startsWith('/blog') &&
      path.length > 5 &&
      path.endsWith('/')
    )
      return reply.redirect(path.replace(/\/+$/, '') + (query ? `?${query}` : ''), 301);
  });

  const consentOf = (req: FastifyRequest): RenderContext['consent'] => {
    const v = req.cookies[CONSENT_COOKIE];
    return v === 'granted' || v === 'denied' ? v : null;
  };

  /** The images a page shows (featured images of cards, the article's own). */
  const mediaFor = async (cards: ArticleCard[], article?: PublicArticle) => {
    const ids = cards.flatMap((c) => (c.featuredMediaId ? [c.featuredMediaId] : []));
    if (article) {
      const r = article.row;
      ids.push(...[r.featuredMediaId, r.ogImageId].filter((x): x is string => !!x));
      ids.push(
        ...article.blocks.flatMap((b: BlogBlock) => (b.type === 'image' ? [b.mediaId] : [])),
      );
    }
    return blog.mediaInfo(ids);
  };

  const ctxOf = async (
    req: FastifyRequest,
    cards: ArticleCard[],
    article?: PublicArticle,
  ): Promise<RenderContext> => ({
    origin,
    assets,
    ga4: o.ga4,
    consent: consentOf(req),
    gscVerification: o.gscVerification,
    media: await mediaFor(cards, article),
    now: blog.clock(),
  });

  const html = (
    reply: FastifyReply,
    body: string,
    ctx: RenderContext,
    o2: { status?: number; cache?: string; robots?: string } = {},
  ) => {
    reply
      .status(o2.status ?? 200)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', pageCsp(usesAnalytics(ctx)))
      // Not no-referrer: with it, browsers send "Origin: null" on the page's own form posts (the
      // analytics choice), which the cross-site check refuses. Other sites still get only the
      // origin (https://veyrafy.com), never the path.
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      // Public pages may be cached briefly by browsers and the edge; they change when editors publish.
      .header('cache-control', o2.cache ?? 'public, max-age=60, stale-while-revalidate=300')
      .header('vary', 'Cookie');
    if (o2.robots) reply.header('x-robots-tag', o2.robots);
    return reply.send(body);
  };

  const notFound = async (req: FastifyRequest, reply: FastifyReply, status: 404 | 410 = 404) => {
    const ctx = await ctxOf(req, []);
    return html(reply, messagePage(ctx, { status, path: req.url.split('?')[0] ?? '/blog' }), ctx, {
      status,
      cache: 'no-store',
      robots: 'noindex',
    });
  };

  const categoriesNav = async () =>
    (await blog.publicCategories()).map((c) => ({ name: c.name, slug: c.slug }));

  // ── Public pages ─────────────────────────────────────────────────────────

  const index = async (req: FastifyRequest, reply: FastifyReply, pageNo: number) => {
    const { items, total } = await blog.publicPage({ page: pageNo, pageSize });
    if (pageNo > 1 && items.length === 0) return notFound(req, reply);
    const ctx = await ctxOf(req, items);
    return html(
      reply,
      blogIndexPage(ctx, {
        items,
        total,
        page: pageNo,
        pageSize,
        categories: await categoriesNav(),
      }),
      ctx,
    );
  };
  app.get('/blog', PUBLIC, async (req, reply) => index(req, reply, 1));
  app.get('/blog/page/:n', PUBLIC, async (req, reply) => {
    const { n } = PageParam.parse(req.params);
    if (n <= 1) return reply.redirect('/blog', 301);
    return index(req, reply, n);
  });

  const archive = async (
    req: FastifyRequest,
    reply: FastifyReply,
    kind: 'category' | 'tag',
    slug: string,
    pageNo: number,
  ) => {
    const term = kind === 'category' ? await blog.categoryBySlug(slug) : await blog.tagBySlug(slug);
    if (!term) return notFound(req, reply);
    const { items, total } = await blog.publicPage({
      page: pageNo,
      pageSize,
      ...(kind === 'category' ? { categoryId: term.id } : { tagId: term.id }),
    });
    // An archive with nothing public is not a page (no empty pages for crawlers).
    if (items.length === 0) return notFound(req, reply);
    const ctx = await ctxOf(req, items);
    return html(
      reply,
      archivePage(ctx, {
        kind,
        name: term.name,
        slug: term.slug,
        description: term.description,
        items,
        total,
        page: pageNo,
        pageSize,
        categories: await categoriesNav(),
      }),
      ctx,
      kind === 'tag' ? { robots: 'noindex, follow' } : {},
    );
  };
  for (const kind of ['category', 'tag'] as const) {
    app.get(`/blog/${kind}/:slug`, PUBLIC, async (req, reply) =>
      archive(req, reply, kind, SlugParam.parse(req.params).slug, 1),
    );
    app.get(`/blog/${kind}/:slug/page/:n`, PUBLIC, async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const { n } = PageParam.parse(req.params);
      if (n <= 1) return reply.redirect(`/blog/${kind}/${slug}`, 301);
      return archive(req, reply, kind, slug, n);
    });
  }

  app.get('/blog/search', PUBLIC, async (req, reply) => {
    const retry = limiter.hit('processing', `blog-search:${req.ip}`);
    if (retry !== null)
      return reply
        .status(429)
        .header('retry-after', String(retry))
        .type('text/plain; charset=utf-8')
        .send('Too many searches. Wait a moment.');
    const query = z
      .object({
        q: z.string().max(200).optional(),
        page: z
          .string()
          .regex(/^\d{1,3}$/)
          .optional(),
      })
      .parse(req.query ?? {});
    const q = (query.q ?? '').trim().slice(0, 120);
    const pageNo = Math.max(1, Number(query.page ?? 1));
    const result = q ? await blog.search(q, pageNo, pageSize) : { items: [], total: 0 };
    const ctx = await ctxOf(req, result.items);
    return html(reply, searchPage(ctx, { q, ...result, page: pageNo, pageSize }), ctx, {
      robots: 'noindex, follow',
      cache: 'no-store',
    });
  });

  app.get('/blog/:slug', PUBLIC, async (req, reply) => {
    const { slug } = SlugParam.parse(req.params);
    if (!SLUG_PATTERN.test(slug)) return notFound(req, reply);
    const article = await blog.publicArticle(slug);
    if (!article) {
      const to = await blog.resolveRedirect(`/blog/${slug}`);
      if (to) return reply.redirect(to, 301);
      return notFound(req, reply, (await blog.gone(slug)) ? 410 : 404);
    }
    const related = await blog.related(article);
    const ctx = await ctxOf(req, related, article);
    return html(
      reply,
      articlePage(ctx, article, related),
      ctx,
      article.row.noindex ? { robots: 'noindex, follow' } : {},
    );
  });

  // Editors' preview of any article, in its final layout (never indexed, never cached).
  app.get('/blog/preview/:id', may('blog.view'), async (req, reply) => {
    const { id } = Id.parse(req.params);
    const article = await blog.previewArticle(id);
    const ctx = await ctxOf(req, [], article);
    return html(reply, articlePage(ctx, article, [], { preview: true }), ctx, {
      cache: 'no-store',
      robots: 'noindex, nofollow',
    });
  });

  app.get('/blog/feed.xml', PUBLIC, async (_req, reply) => {
    const { items } = await blog.publicPage({ page: 1, pageSize: 20 });
    return reply
      .header('content-type', 'application/rss+xml; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(rssXml(origin, items, blog.clock()));
  });

  app.get('/sitemap.xml', PUBLIC, async (_req, reply) => {
    const [articles, categories] = await Promise.all([
      blog.sitemapArticles(),
      blog.publicCategories(),
    ]);
    const blogLastmod =
      articles
        .map((a) => a.lastmod)
        .sort()
        .at(-1) ?? null;
    return reply
      .header('content-type', 'application/xml; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(
        sitemapXml(origin, {
          staticPages: [{ path: '/' }],
          blogLastmod,
          categories: categories.map((c) => ({ slug: c.slug, lastmod: c.lastmod })),
          articles,
        }),
      );
  });

  app.get('/blog/media/:file', PUBLIC, async (req, reply) => {
    const { file } = z.object({ file: z.string().max(60) }).parse(req.params);
    const m = /^([0-9A-HJKMNP-TV-Z]{26})(-800)?\.webp$/.exec(file);
    if (!m?.[1]) return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    const found = await blog.mediaFile(m[1], m[2] !== undefined);
    if (!found) return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    return reply
      .header('content-type', found.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'same-origin')
      .send(found.body);
  });

  for (const a of [assets.css, assets.js])
    app.get(a.path, PUBLIC, async (_req, reply) =>
      reply
        .header(
          'content-type',
          a.path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        )
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(a.body),
    );

  // The visitor's analytics choice: a plain form, kept in a first-party cookie the server reads.
  app.post('/blog/consent', PUBLIC, async (req, reply) => {
    const retry = limiter.hit('processing', `blog-consent:${req.ip}`);
    if (retry !== null) return reply.status(429).send('Too many requests.');
    const body = z
      .object({ choice: z.enum(['granted', 'denied']), return: z.string().max(300).optional() })
      .parse(req.body ?? {});
    const back =
      body.return && /^\/(?!\/)[A-Za-z0-9._~\-/]*$/.test(body.return) ? body.return : '/blog';
    void reply.setCookie(CONSENT_COOKIE, body.choice, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: o.cookieSecure,
      maxAge: 180 * 24 * 3600,
    });
    return reply.redirect(back, 303);
  });

  // ── Studio API (signed-in editors) ───────────────────────────────────────

  const send = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => schema.parse(value);

  app.get('/api/v1/blog/articles', may('blog.view'), async (req) => {
    const q = z
      .object({
        status: z.enum(BLOG_STATUSES).optional(),
        categoryId: z.string().max(26).optional(),
        authorId: z.string().max(26).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        q: z.string().max(120).optional(),
      })
      .parse(req.query ?? {});
    return send(z.array(ApiBlogSummarySchema), await blog.list(q));
  });

  app.post('/api/v1/blog/articles', may('blog.write'), async (req, reply) =>
    reply
      .status(201)
      .send(
        send(
          ApiBlogArticleSchema,
          await blog.create(BlogArticleInputSchema.parse(req.body ?? {}), actorOf(req)),
        ),
      ),
  );

  app.get('/api/v1/blog/articles/:id', may('blog.view'), async (req) =>
    send(ApiBlogArticleSchema, await blog.get(Id.parse(req.params).id)),
  );

  app.put('/api/v1/blog/articles/:id', may('blog.write'), async (req) => {
    const body = BlogSaveSchema.parse(req.body ?? {});
    const { id } = Id.parse(req.params);
    // Changing a live article is publishing: it needs the publishing permission too.
    const current = await blog.get(id);
    if (current.live || current.status === 'SCHEDULED') requirePermission(req, 'blog.publish');
    return send(
      ApiBlogArticleSchema,
      await blog.save(id, body.article, body.baseVersion, body.autosave, actorOf(req)),
    );
  });

  app.post('/api/v1/blog/articles/:id/status', may('blog.write'), async (req) => {
    const body = BlogStatusChangeSchema.parse(req.body ?? {});
    const { id } = Id.parse(req.params);
    const current = await blog.get(id);
    // Moving into or out of public view is publishing; review and draft moves are writing.
    if (
      ['SCHEDULED', 'PUBLISHED', 'ARCHIVED'].includes(body.to) ||
      current.live ||
      current.status === 'SCHEDULED'
    )
      requirePermission(req, 'blog.publish');
    return send(
      ApiBlogArticleSchema,
      await blog.changeStatus(id, body.to, body.publishAt ?? null, body.baseVersion, actorOf(req)),
    );
  });

  app.post('/api/v1/blog/articles/:id/duplicate', may('blog.write'), async (req, reply) =>
    reply
      .status(201)
      .send(
        send(ApiBlogArticleSchema, await blog.duplicate(Id.parse(req.params).id, actorOf(req))),
      ),
  );

  app.post('/api/v1/blog/articles/:id/delete', may('blog.write'), async (req) => {
    const { baseVersion } = z
      .object({ baseVersion: z.number().int().min(1) })
      .strict()
      .parse(req.body ?? {});
    await blog.remove(Id.parse(req.params).id, baseVersion, actorOf(req));
    return { ok: true };
  });

  app.get('/api/v1/blog/articles/:id/revisions', may('blog.view'), async (req) =>
    send(z.array(ApiBlogRevisionSchema), await blog.revisions(Id.parse(req.params).id)),
  );

  app.post('/api/v1/blog/articles/:id/restore', may('blog.write'), async (req) => {
    const body = z
      .object({ revisionId: Id.shape.id, baseVersion: z.number().int().min(1) })
      .strict()
      .parse(req.body ?? {});
    const { id } = Id.parse(req.params);
    const current = await blog.get(id);
    if (current.live || current.status === 'SCHEDULED') requirePermission(req, 'blog.publish');
    return send(
      ApiBlogArticleSchema,
      await blog.restore(id, body.revisionId, body.baseVersion, actorOf(req)),
    );
  });

  app.get('/api/v1/blog/articles/:id/events', may('blog.view'), async (req) =>
    send(z.array(ApiBlogEventSchema), await blog.events(Id.parse(req.params).id)),
  );

  app.get('/api/v1/blog/events', may('blog.view'), async () =>
    send(z.array(ApiBlogEventSchema), await blog.events(null)),
  );

  // The checks for an article as it is being written (nothing is saved).
  app.post('/api/v1/blog/checks', may('blog.view'), async (req) => ({
    issues: await blog.checks(BlogArticleInputSchema.parse(req.body ?? {})),
  }));

  app.get('/api/v1/blog/taxonomy', may('blog.view'), async () => ({
    categories: send(z.array(ApiBlogTermSchema), await blog.categories()),
    tags: send(z.array(ApiBlogTermSchema), await blog.tags()),
    authors: send(z.array(ApiBlogAuthorSchema), await blog.authors()),
  }));

  for (const kind of ['categories', 'tags'] as const) {
    const save = kind === 'categories' ? blog.saveCategory.bind(blog) : blog.saveTag.bind(blog);
    app.post(`/api/v1/blog/${kind}`, may('blog.write'), async (req, reply) =>
      reply.status(201).send({
        id: await save(null, BlogTaxonomyInputSchema.parse(req.body ?? {}), actorOf(req)),
      }),
    );
    app.put(`/api/v1/blog/${kind}/:id`, may('blog.write'), async (req) => ({
      id: await save(
        Id.parse(req.params).id,
        BlogTaxonomyInputSchema.parse(req.body ?? {}),
        actorOf(req),
      ),
    }));
  }
  app.post('/api/v1/blog/authors', may('blog.write'), async (req, reply) =>
    reply.status(201).send({
      id: await blog.saveAuthor(null, BlogAuthorInputSchema.parse(req.body ?? {}), actorOf(req)),
    }),
  );
  app.put('/api/v1/blog/authors/:id', may('blog.write'), async (req) => ({
    id: await blog.saveAuthor(
      Id.parse(req.params).id,
      BlogAuthorInputSchema.parse(req.body ?? {}),
      actorOf(req),
    ),
  }));

  app.get('/api/v1/blog/media', may('blog.view'), async () =>
    send(z.array(ApiBlogMediaSchema), await blog.media()),
  );

  app.post('/api/v1/blog/media', may('blog.write'), async (req, reply) => {
    const retry = limiter.hit('upload', `blog-media:${req.ip}`);
    if (retry !== null)
      throw new VeyraError('RATE_LIMITED', 'Too many uploads. Wait a moment and try again.');
    const file = await req.file();
    if (!file) throw new VeyraError('INVALID_INPUT', 'Attach an image.');
    const bytes = new Uint8Array(await file.toBuffer());
    const alt = (file.fields.alt as { value?: unknown } | undefined)?.value;
    return reply
      .status(201)
      .send(
        send(
          ApiBlogMediaSchema,
          await blog.upload(bytes, typeof alt === 'string' ? alt : '', actorOf(req)),
        ),
      );
  });

  app.post('/api/v1/blog/media/:id/alt', may('blog.write'), async (req) => {
    const { alt } = z
      .object({ alt: z.string().max(300) })
      .strict()
      .parse(req.body ?? {});
    await blog.setMediaAlt(Id.parse(req.params).id, alt, actorOf(req));
    return { ok: true };
  });

  app.post('/api/v1/blog/media/:id/retire', may('blog.write'), async (req) => {
    await blog.retireMedia(Id.parse(req.params).id, actorOf(req));
    return { ok: true };
  });

  app.get('/api/v1/blog/redirects', may('blog.view'), async () =>
    send(z.array(ApiBlogRedirectSchema), await blog.redirects()),
  );

  app.post('/api/v1/blog/redirects', may('blog.write'), async (req, reply) => {
    const body = BlogRedirectInputSchema.parse(req.body ?? {});
    await blog.addRedirect(body.fromPath, body.toPath, actorOf(req));
    return reply.status(201).send({ ok: true });
  });

  app.post('/api/v1/blog/redirects/:id/remove', may('blog.write'), async (req) => {
    await blog.removeRedirect(Id.parse(req.params).id, actorOf(req));
    return { ok: true };
  });
}
