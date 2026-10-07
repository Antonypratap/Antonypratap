import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ApiBlogMedia, BlogArticleInput, BlogStatus } from '@veyra/shared';
import { ApiError } from '../product/api/client';
import { studioApi } from './api';
import styles from './Studio.module.css';

/** Pieces shared by the studio's screens (routing, loading, labels, media upload, history). */
export const STUDIO_PATH = '/admin/blog';
export const isStudioPage = (pathname: string): boolean =>
  pathname === STUDIO_PATH || pathname.startsWith(`${STUDIO_PATH}/`);

/** Moves within the studio without reloading. */
export function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

export function StudioLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

export const errorText = (e: unknown, fallback = 'That did not work. Try again.') =>
  e instanceof ApiError ? e.message : fallback;

/** Loads once per key; `reload` fetches again. */
export function useLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({
    key,
    data: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ key, data, error: null }),
      (e: unknown) =>
        live && setState({ key, data: null, error: errorText(e, 'This could not be loaded.') }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return {
    data: state.key === key ? state.data : null,
    error: state.key === key ? state.error : null,
    reload,
  };
}

const STATUS_LABEL: Record<BlogStatus, string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  SCHEDULED: 'Scheduled',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};
export const statusLabel = (s: BlogStatus) => STATUS_LABEL[s];

export function StatusBadge({ status, live }: { status: BlogStatus; live?: boolean }) {
  return (
    <span className={styles.badge} data-status={status}>
      {STATUS_LABEL[status]}
      {status === 'SCHEDULED' && live ? ' (live)' : ''}
    </span>
  );
}

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});
export const when = (iso: string | null) => (iso ? DATE.format(new Date(iso)) : '—');

export const emptyArticle = (title: string, slug: string): BlogArticleInput => ({
  title,
  slug,
  excerpt: '',
  blocks: [{ type: 'paragraph', text: '' }],
  faq: [],
  authorId: null,
  categoryId: null,
  tagIds: [],
  seoTitle: null,
  metaDescription: null,
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
});

export function MediaUpload({ onDone }: { onDone: (m: ApiBlogMedia) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const m = await studioApi.upload(file, alt);
      setFile(null);
      setAlt('');
      onDone(m);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={styles.inlineForm} onSubmit={(e) => void submit(e)}>
      <label className={styles.field}>
        Image (PNG, JPEG or WebP, up to 8 MB)
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <label className={styles.field}>
        Alt text (what the image shows, for people who cannot see it)
        <input maxLength={300} value={alt} onChange={(e) => setAlt(e.target.value)} />
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button type="submit" className={styles.primary} disabled={!file || busy}>
        {busy ? 'Uploading…' : 'Upload'}
      </button>
    </form>
  );
}

const EVENT_LABEL: Record<string, string> = {
  'article.created': 'Article created',
  'article.updated': 'Article saved',
  'article.duplicated': 'Article duplicated',
  'article.status': 'Status changed',
  'article.slug_changed': 'URL changed',
  'article.restored': 'Revision restored',
  'article.deleted': 'Draft deleted',
  'media.uploaded': 'Image uploaded',
  'media.deleted': 'Image removed',
  'taxonomy.changed': 'Category or tag changed',
  'author.changed': 'Author changed',
  'redirect.changed': 'Redirect changed',
};

export function EventList({ articleId }: { articleId: string | null }) {
  const events = useLoad(() => studioApi.events(articleId), `events:${articleId ?? ''}`);
  return (
    <ol className={styles.events}>
      {events.data?.map((e) => (
        <li key={e.id}>
          <strong>{EVENT_LABEL[e.event] ?? e.event}</strong>
          {e.event === 'article.status' &&
            typeof e.detail.from === 'string' &&
            typeof e.detail.to === 'string' && (
              <span>
                {' '}
                {statusLabel(e.detail.from as BlogStatus)} →{' '}
                {statusLabel(e.detail.to as BlogStatus)}
              </span>
            )}
          <span className={styles.muted}>
            {' '}
            · {e.userName ?? 'Veyrafy (automatic)'} · {when(e.createdAt)}
          </span>
        </li>
      ))}
      {events.data?.length === 0 && <li className={styles.muted}>Nothing yet.</li>}
    </ol>
  );
}
