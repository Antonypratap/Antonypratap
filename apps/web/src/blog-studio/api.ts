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
  type ApiBlogArticle,
  type BlogArticleInput,
  type BlogIssue,
  type BlogStatus,
} from '@veyra/shared';
import { csrfHeaders, sessionEnded } from '../access/session';
import { API, API_CREDENTIALS } from '../api-endpoint';
import { ApiError, json, request } from '../product/api/client';

/**
 * The publishing studio's calls (/api/v1/blog/…). The server checks the signed-in editor's
 * permission on every one; nothing here decides what is allowed.
 */
const put = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const Ok = z.object({ ok: z.literal(true) });
const IdOnly = z.object({ id: z.string() });
const Issues = z.object({
  issues: z.array(
    z.object({
      level: z.enum(['error', 'warning', 'info']),
      field: z.string(),
      message: z.string(),
    }),
  ),
});
const Taxonomy = z.object({
  categories: z.array(ApiBlogTermSchema),
  tags: z.array(ApiBlogTermSchema),
  authors: z.array(ApiBlogAuthorSchema),
});
export type Taxonomy = z.infer<typeof Taxonomy>;

export interface ListFilter {
  status?: BlogStatus | '';
  categoryId?: string;
  authorId?: string;
  from?: string;
  to?: string;
  q?: string;
}

export const studioApi = {
  list: (f: ListFilter) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
    const qs = p.toString();
    return request(z.array(ApiBlogSummarySchema), `/blog/articles${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => request(ApiBlogArticleSchema, `/blog/articles/${id}`),
  create: (article: BlogArticleInput) =>
    request(ApiBlogArticleSchema, '/blog/articles', json(article)),
  save: (id: string, article: BlogArticleInput, baseVersion: number, autosave: boolean) =>
    request(ApiBlogArticleSchema, `/blog/articles/${id}`, put({ article, baseVersion, autosave })),
  status: (id: string, to: BlogStatus, baseVersion: number, publishAt: string | null = null) =>
    request(
      ApiBlogArticleSchema,
      `/blog/articles/${id}/status`,
      json({ to, baseVersion, publishAt }),
    ),
  duplicate: (id: string) =>
    request(ApiBlogArticleSchema, `/blog/articles/${id}/duplicate`, json({})),
  remove: (id: string, baseVersion: number) =>
    request(Ok, `/blog/articles/${id}/delete`, json({ baseVersion })),
  revisions: (id: string) =>
    request(z.array(ApiBlogRevisionSchema), `/blog/articles/${id}/revisions`),
  restore: (id: string, revisionId: string, baseVersion: number) =>
    request(
      ApiBlogArticleSchema,
      `/blog/articles/${id}/restore`,
      json({ revisionId, baseVersion }),
    ),
  events: (id: string | null) =>
    request(z.array(ApiBlogEventSchema), id ? `/blog/articles/${id}/events` : '/blog/events'),
  checks: async (article: BlogArticleInput): Promise<BlogIssue[]> =>
    (await request(Issues, '/blog/checks', json(article))).issues,
  taxonomy: () => request(Taxonomy, '/blog/taxonomy'),
  saveTerm: (
    kind: 'categories' | 'tags',
    id: string | null,
    v: { name: string; slug: string; description: string },
  ) => request(IdOnly, id ? `/blog/${kind}/${id}` : `/blog/${kind}`, id ? put(v) : json(v)),
  saveAuthor: (id: string | null, v: { name: string; slug: string; role: string; bio: string }) =>
    request(IdOnly, id ? `/blog/authors/${id}` : '/blog/authors', id ? put(v) : json(v)),
  media: () => request(z.array(ApiBlogMediaSchema), '/blog/media'),
  setAlt: (id: string, alt: string) => request(Ok, `/blog/media/${id}/alt`, json({ alt })),
  retireMedia: (id: string) => request(Ok, `/blog/media/${id}/retire`, json({})),
  redirects: () => request(z.array(ApiBlogRedirectSchema), '/blog/redirects'),
  addRedirect: (fromPath: string, toPath: string) =>
    request(z.object({ ok: z.literal(true) }), '/blog/redirects', json({ fromPath, toPath })),
  removeRedirect: (id: string) => request(Ok, `/blog/redirects/${id}/remove`, json({})),
  /** Uploads an image (multipart; the server re-encodes it). */
  upload: async (file: File, alt: string) => {
    const form = new FormData();
    form.append('alt', alt);
    form.append('file', file, file.name);
    let res: Response;
    try {
      res = await fetch(`${API.base}/blog/media`, {
        method: 'POST',
        body: form,
        credentials: API_CREDENTIALS,
        headers: csrfHeaders(),
      });
    } catch {
      throw new ApiError(0, 'OFFLINE', 'Veyrafy could not be reached.');
    }
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 401) sessionEnded();
    if (!res.ok) {
      const e = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .safeParse(body);
      throw new ApiError(
        res.status,
        e.success ? e.data.error.code : 'HTTP',
        e.success ? e.data.error.message : 'The upload failed.',
      );
    }
    return ApiBlogMediaSchema.parse(body);
  },
};

export type { ApiBlogArticle };
