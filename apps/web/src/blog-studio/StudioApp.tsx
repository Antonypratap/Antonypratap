import { useEffect, useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  BLOG_STATUSES,
  slugify,
  type ApiBlogMedia,
  type ApiBlogRedirect,
  type ApiBlogSummary,
  type BlogStatus,
} from '@veyra/shared';
import { allowed, signOut, useSession } from '../access/session';
import { Logo } from '../design-system';
import { notify } from '../feedback/toasts';
import { studioApi, type ListFilter } from './api';
import { Editor } from './Editor';
import {
  EventList,
  MediaUpload,
  STUDIO_PATH,
  StatusBadge,
  StudioLink,
  emptyArticle,
  errorText,
  go,
  statusLabel,
  useLoad,
  when,
} from './common';
import styles from './Studio.module.css';

/**
 * The blog's publishing studio (veyrafy.com/admin/blog), for Veyrafy's editors. It only presents
 * what the server returns and sends what the editor chose: the server checks the editor's
 * permission on every call, validates every article and decides what may be published.
 */
type Page =
  | { page: 'list' }
  | { page: 'edit'; id: string }
  | { page: 'taxonomy' }
  | { page: 'authors' }
  | { page: 'media' }
  | { page: 'redirects' }
  | { page: 'history' };

function parse(pathname: string): Page {
  const rest = pathname.slice(STUDIO_PATH.length).replace(/\/+$/, '');
  const m = /^\/articles\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(rest);
  if (m?.[1]) return { page: 'edit', id: m[1] };
  if (rest === '/categories') return { page: 'taxonomy' };
  if (rest === '/authors') return { page: 'authors' };
  if (rest === '/media') return { page: 'media' };
  if (rest === '/redirects') return { page: 'redirects' };
  if (rest === '/history') return { page: 'history' };
  return { page: 'list' };
}

const subscribe = (fn: () => void) => {
  window.addEventListener('popstate', fn);
  return () => window.removeEventListener('popstate', fn);
};
const usePathname = () =>
  useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => STUDIO_PATH,
  );

const NAV: { to: string; label: string; page: Page['page'] }[] = [
  { to: STUDIO_PATH, label: 'Articles', page: 'list' },
  { to: `${STUDIO_PATH}/categories`, label: 'Categories & tags', page: 'taxonomy' },
  { to: `${STUDIO_PATH}/authors`, label: 'Authors', page: 'authors' },
  { to: `${STUDIO_PATH}/media`, label: 'Media', page: 'media' },
  { to: `${STUDIO_PATH}/redirects`, label: 'Redirects', page: 'redirects' },
  { to: `${STUDIO_PATH}/history`, label: 'History', page: 'history' },
];

export function StudioApp() {
  const route = parse(usePathname());
  const session = useSession();
  useEffect(() => {
    document.title = 'Blog studio · Veyrafy';
  }, []);
  if (session.status !== 'signedIn') return null;
  if (!allowed('blog.view'))
    return (
      <main className={styles.denied} role="alert">
        <Logo />
        <h1>The blog studio is for Veyrafy’s editors</h1>
        <p>This account cannot open it.</p>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </main>
    );
  const active = route.page === 'edit' ? 'list' : route.page;
  return (
    <div className={styles.shell}>
      <header className={styles.top}>
        <a href="/" className={styles.brand} aria-label="Veyrafy website">
          <Logo />
        </a>
        <span className={styles.product}>Blog studio</span>
        <nav aria-label="Studio" className={styles.nav}>
          {NAV.map((n) => (
            <StudioLink
              key={n.to}
              to={n.to}
              className={n.page === active ? styles.navActive : styles.navLink}
            >
              {n.label}
            </StudioLink>
          ))}
        </nav>
        <div className={styles.account}>
          <a href="/blog" target="_blank" rel="noopener">
            View blog
          </a>
          <span>{session.session.user.name}</span>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className={styles.main} id="studio-main">
        {route.page === 'list' && <ArticleList />}
        {route.page === 'edit' && <Editor key={route.id} id={route.id} />}
        {route.page === 'taxonomy' && <TaxonomyPage />}
        {route.page === 'authors' && <AuthorsPage />}
        {route.page === 'media' && <MediaPage />}
        {route.page === 'redirects' && <RedirectsPage />}
        {route.page === 'history' && <HistoryPage />}
      </main>
    </div>
  );
}

// ── Articles ────────────────────────────────────────────────────────────────

function ArticleList() {
  const [filter, setFilter] = useState<ListFilter>({});
  const tax = useLoad(() => studioApi.taxonomy(), 'taxonomy');
  const key = JSON.stringify(filter);
  const list = useLoad(() => studioApi.list(filter), key);
  const [creating, setCreating] = useState(false);
  const set = (patch: Partial<ListFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const name = (items: { id: string; name: string }[] | undefined, id: string | null) =>
    items?.find((x) => x.id === id)?.name ?? '—';
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`}>
      <div className={styles.pageHead}>
        <h1 id={`${id}-h`}>Articles</h1>
        {allowed('blog.write') && (
          <button type="button" className={styles.primary} onClick={() => setCreating(true)}>
            New article
          </button>
        )}
      </div>
      {creating && <NewArticle onClose={() => setCreating(false)} />}
      <form className={styles.filters} role="search" onSubmit={(e) => e.preventDefault()}>
        <label>
          Search
          <input
            type="search"
            value={filter.q ?? ''}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Title or slug"
          />
        </label>
        <label>
          Status
          <select
            value={filter.status ?? ''}
            onChange={(e) => set({ status: e.target.value as BlogStatus | '' })}
          >
            <option value="">All</option>
            {BLOG_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select
            value={filter.categoryId ?? ''}
            onChange={(e) => set({ categoryId: e.target.value })}
          >
            <option value="">All</option>
            {tax.data?.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Author
          <select value={filter.authorId ?? ''} onChange={(e) => set({ authorId: e.target.value })}>
            <option value="">All</option>
            {tax.data?.authors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            value={filter.from?.slice(0, 10) ?? ''}
            onChange={(e) => set({ from: e.target.value ? `${e.target.value}T00:00:00.000Z` : '' })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={filter.to?.slice(0, 10) ?? ''}
            onChange={(e) => set({ to: e.target.value ? `${e.target.value}T23:59:59.999Z` : '' })}
          />
        </label>
      </form>
      {list.error && (
        <p className={styles.error} role="alert">
          {list.error}
        </p>
      )}
      {list.data && list.data.length === 0 && <p className={styles.muted}>No articles match.</p>}
      {list.data && list.data.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th scope="col">Category</th>
                <th scope="col">Author</th>
                <th scope="col">Published</th>
                <th scope="col">Last change</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((a: ApiBlogSummary) => (
                <tr key={a.id}>
                  <td>
                    <StudioLink to={`${STUDIO_PATH}/articles/${a.id}`}>
                      {a.title || 'Untitled'}
                    </StudioLink>
                    <span className={styles.slug}>/blog/{a.slug}</span>
                    {a.notes > 0 && (
                      <span className={styles.noteFlag}>
                        Outline: {a.notes} editorial note{a.notes === 1 ? '' : 's'}
                      </span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={a.status} live={a.live} />
                  </td>
                  <td>{name(tax.data?.categories, a.categoryId)}</td>
                  <td>{name(tax.data?.authors, a.authorId)}</td>
                  <td>{when(a.publishedAt)}</td>
                  <td>{when(a.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function NewArticle({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const a = await studioApi.create(emptyArticle(title.trim(), slug));
      notify.blogCreated();
      go(`${STUDIO_PATH}/articles/${a.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <form className={styles.card} onSubmit={(e) => void submit(e)} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>New article</h2>
      <label className={styles.field}>
        Title
        <input
          required
          maxLength={160}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
        />
      </label>
      <label className={styles.field}>
        URL slug
        <span className={styles.prefixed}>
          <span>/blog/</span>
          <input
            required
            maxLength={80}
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
        </span>
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.row}>
        <button type="submit" className={styles.primary} disabled={busy || !title.trim() || !slug}>
          Create draft
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Categories, tags, authors ───────────────────────────────────────────────

function TermEditor({
  title,
  items,
  onSave,
  withRole,
}: {
  title: string;
  items: {
    id: string;
    name: string;
    slug: string;
    description?: string;
    role?: string;
    bio?: string;
    articles: number;
  }[];
  onSave: (
    id: string | null,
    v: { name: string; slug: string; description: string; role: string; bio: string },
  ) => Promise<void>;
  withRole?: boolean;
}) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [v, setV] = useState({ name: '', slug: '', description: '', role: '', bio: '' });
  const [error, setError] = useState<string | null>(null);
  const start = (id: string | 'new') => {
    const it = items.find((x) => x.id === id);
    setV({
      name: it?.name ?? '',
      slug: it?.slug ?? '',
      description: it?.description ?? '',
      role: it?.role ?? '',
      bio: it?.bio ?? '',
    });
    setError(null);
    setEditing(id);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onSave(editing === 'new' ? null : editing, v);
      setEditing(null);
      notify.blogChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const canWrite = allowed('blog.write');
  return (
    <section className={styles.card}>
      <div className={styles.pageHead}>
        <h2>{title}</h2>
        {canWrite && (
          <button type="button" onClick={() => start('new')}>
            Add
          </button>
        )}
      </div>
      {editing && (
        <form onSubmit={(e) => void submit(e)} className={styles.inlineForm}>
          <label className={styles.field}>
            Name
            <input
              required
              maxLength={120}
              value={v.name}
              onChange={(e) =>
                setV({
                  ...v,
                  name: e.target.value,
                  slug: editing === 'new' ? slugify(e.target.value) : v.slug,
                })
              }
            />
          </label>
          <label className={styles.field}>
            Slug
            <input
              required
              maxLength={80}
              value={v.slug}
              onChange={(e) => setV({ ...v, slug: e.target.value })}
            />
          </label>
          {withRole ? (
            <>
              <label className={styles.field}>
                Role
                <input
                  maxLength={120}
                  value={v.role}
                  onChange={(e) => setV({ ...v, role: e.target.value })}
                />
              </label>
              <label className={styles.field}>
                Short bio
                <textarea
                  maxLength={600}
                  rows={3}
                  value={v.bio}
                  onChange={(e) => setV({ ...v, bio: e.target.value })}
                />
              </label>
            </>
          ) : (
            <label className={styles.field}>
              Description (shown on its archive page)
              <textarea
                maxLength={400}
                rows={2}
                value={v.description}
                onChange={(e) => setV({ ...v, description: e.target.value })}
              />
            </label>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.row}>
            <button type="submit" className={styles.primary}>
              Save
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ul className={styles.termList}>
        {items.map((it) => (
          <li key={it.id}>
            <span>
              <strong>{it.name}</strong> <span className={styles.slug}>{it.slug}</span>
            </span>
            <span className={styles.muted}>
              {it.articles} article{it.articles === 1 ? '' : 's'}
            </span>
            {canWrite && (
              <button type="button" onClick={() => start(it.id)}>
                Edit
              </button>
            )}
          </li>
        ))}
        {items.length === 0 && <li className={styles.muted}>None yet.</li>}
      </ul>
      <p className={styles.muted}>
        Categories, tags and authors are renamed, never deleted, so no article loses its own.
      </p>
    </section>
  );
}

function TaxonomyPage() {
  const tax = useLoad(() => studioApi.taxonomy(), 'taxonomy');
  const save =
    (kind: 'categories' | 'tags') =>
    async (id: string | null, v: { name: string; slug: string; description: string }) => {
      await studioApi.saveTerm(kind, id, {
        name: v.name,
        slug: v.slug,
        description: v.description,
      });
      tax.reload();
    };
  return (
    <>
      <h1>Categories & tags</h1>
      {tax.error && <p className={styles.error}>{tax.error}</p>}
      {tax.data && (
        <div className={styles.twoCol}>
          <TermEditor title="Categories" items={tax.data.categories} onSave={save('categories')} />
          <TermEditor title="Tags" items={tax.data.tags} onSave={save('tags')} />
        </div>
      )}
    </>
  );
}

function AuthorsPage() {
  const tax = useLoad(() => studioApi.taxonomy(), 'taxonomy');
  return (
    <>
      <h1>Authors</h1>
      {tax.data && (
        <TermEditor
          title="Authors"
          withRole
          items={tax.data.authors}
          onSave={async (id, v) => {
            await studioApi.saveAuthor(id, {
              name: v.name,
              slug: v.slug,
              role: v.role,
              bio: v.bio,
            });
            tax.reload();
          }}
        />
      )}
    </>
  );
}

// ── Media ───────────────────────────────────────────────────────────────────

function MediaPage() {
  const media = useLoad(() => studioApi.media(), 'media');
  return (
    <>
      <h1>Media</h1>
      {allowed('blog.write') && (
        <section className={styles.card}>
          <h2>Upload an image</h2>
          <p className={styles.muted}>
            Every image is re-encoded by the server: location and camera details are removed.
          </p>
          <MediaUpload onDone={() => media.reload()} />
        </section>
      )}
      {media.error && <p className={styles.error}>{media.error}</p>}
      <ul className={styles.mediaGrid}>
        {media.data?.map((m) => (
          <MediaItem key={m.id} m={m} onChange={media.reload} />
        ))}
      </ul>
    </>
  );
}

function MediaItem({ m, onChange }: { m: ApiBlogMedia; onChange: () => void }) {
  const [alt, setAlt] = useState(m.alt);
  return (
    <li className={styles.mediaItem}>
      <img src={m.url} alt={m.alt} width={m.width} height={m.height} loading="lazy" />
      <p className={styles.muted}>
        {m.width}×{m.height} · {Math.round(m.bytes / 1024)} KB
      </p>
      <label className={styles.field}>
        Alt text
        <input value={alt} maxLength={300} onChange={(e) => setAlt(e.target.value)} />
      </label>
      {allowed('blog.write') && (
        <div className={styles.row}>
          <button
            type="button"
            disabled={alt === m.alt}
            onClick={() =>
              void studioApi.setAlt(m.id, alt).then(
                () => {
                  notify.blogChanged();
                  onChange();
                },
                () => notify.blogFailed(),
              )
            }
          >
            Save alt text
          </button>
          <button
            type="button"
            className={styles.danger}
            onClick={() => {
              if (
                !window.confirm(
                  'Remove this image from the media library? It will no longer be served. Images used by an article cannot be removed.',
                )
              )
                return;
              void studioApi.retireMedia(m.id).then(onChange, () => notify.blogFailed());
            }}
          >
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

// ── Redirects and history ───────────────────────────────────────────────────

function RedirectsPage() {
  const list = useLoad(() => studioApi.redirects(), 'redirects');
  const [from, setFrom] = useState('/blog/');
  const [to, setTo] = useState('/blog/');
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await studioApi.addRedirect(from, to);
      setFrom('/blog/');
      setTo('/blog/');
      list.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <>
      <h1>Redirects</h1>
      <p className={styles.muted}>
        Changing the slug of an article that has been published adds a permanent (301) redirect
        automatically. Add one here only for other moved pages.
      </p>
      {allowed('blog.write') && (
        <form className={`${styles.card} ${styles.inlineForm}`} onSubmit={(e) => void add(e)}>
          <label className={styles.field}>
            From (old path)
            <input value={from} onChange={(e) => setFrom(e.target.value)} maxLength={300} />
          </label>
          <label className={styles.field}>
            To (new path)
            <input value={to} onChange={(e) => setTo(e.target.value)} maxLength={300} />
          </label>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button type="submit" className={styles.primary}>
            Add redirect
          </button>
        </form>
      )}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Used</th>
              <th scope="col">Added</th>
              <th scope="col">
                <span className={styles.sr}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((r: ApiBlogRedirect) => (
              <tr key={r.id}>
                <td>{r.fromPath}</td>
                <td>{r.toPath}</td>
                <td>{r.hits}</td>
                <td>{when(r.createdAt)}</td>
                <td>
                  {allowed('blog.write') && (
                    <button
                      type="button"
                      className={styles.danger}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Stop redirecting ${r.fromPath}? Links to it will show "not found".`,
                          )
                        )
                          return;
                        void studioApi
                          .removeRedirect(r.id)
                          .then(list.reload, () => notify.blogFailed());
                      }}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HistoryPage() {
  return (
    <>
      <h1>Publishing history</h1>
      <p className={styles.muted}>
        Every change, who made it and when. The history cannot be edited.
      </p>
      <section className={styles.card}>
        <EventList articleId={null} />
      </section>
    </>
  );
}
