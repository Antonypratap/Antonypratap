import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  BLOG_LIMITS,
  blockingIssues,
  slugify,
  type ApiBlogArticle,
  type ApiBlogMedia,
  type BlogArticleInput,
  type BlogBlock,
  type BlogIssue,
  type BlogStatus,
} from '@veyra/shared';
import { allowed } from '../access/session';
import { notify } from '../feedback/toasts';
import { ApiError } from '../product/api/client';
import { studioApi } from './api';
import {
  EventList,
  MediaUpload,
  STUDIO_PATH,
  StatusBadge,
  errorText,
  go,
  statusLabel,
  useLoad,
  when,
} from './common';
import styles from './Studio.module.css';

/**
 * One article in the studio. Drafts save themselves a few seconds after each change; an article
 * that is public (or scheduled) is only ever saved by hand, so half-written edits never go live.
 * The server checks everything again on every save and refuses to publish an article with errors.
 */
const AUTOSAVE_MS = 4000;
const CHECK_MS = 700;

const BLOCK_TYPES: { type: BlogBlock['type']; label: string; make: () => BlogBlock }[] = [
  { type: 'paragraph', label: 'Paragraph', make: () => ({ type: 'paragraph', text: '' }) },
  { type: 'heading', label: 'Heading', make: () => ({ type: 'heading', level: 2, text: '' }) },
  { type: 'list', label: 'List', make: () => ({ type: 'list', ordered: false, items: [''] }) },
  { type: 'quote', label: 'Quote', make: () => ({ type: 'quote', text: '' }) },
  { type: 'image', label: 'Image', make: () => ({ type: 'image', mediaId: '', alt: '' }) },
  {
    type: 'table',
    label: 'Table',
    make: () => ({ type: 'table', header: ['Column 1', 'Column 2'], rows: [['', '']] }),
  },
  { type: 'callout', label: 'Callout', make: () => ({ type: 'callout', tone: 'info', text: '' }) },
  { type: 'note', label: 'Editorial note', make: () => ({ type: 'note', text: '' }) },
];
const blockLabel = (b: BlogBlock) =>
  b.type === 'heading'
    ? `Heading ${b.level}`
    : (BLOCK_TYPES.find((t) => t.type === b.type)?.label ?? b.type);

type SaveState =
  | { kind: 'saved'; at: string }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

export function Editor({ id }: { id: string }) {
  const loaded = useLoad(() => studioApi.get(id), `article:${id}`);
  const tax = useLoad(() => studioApi.taxonomy(), 'taxonomy');
  const media = useLoad(() => studioApi.media(), 'media');
  if (loaded.error)
    return (
      <p className={styles.error} role="alert">
        {loaded.error}
      </p>
    );
  if (!loaded.data || !tax.data || !media.data) return <p className={styles.muted}>Loading…</p>;
  return (
    <Loaded initial={loaded.data} tax={tax.data} media={media.data} reloadMedia={media.reload} />
  );
}

function Loaded({
  initial,
  tax,
  media,
  reloadMedia,
}: {
  initial: ApiBlogArticle;
  tax: Awaited<ReturnType<typeof studioApi.taxonomy>>;
  media: ApiBlogMedia[];
  reloadMedia: () => void;
}) {
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState<BlogArticleInput>(initial.article);
  const [save, setSave] = useState<SaveState>({ kind: 'saved', at: initial.updatedAt });
  const [issues, setIssues] = useState<BlogIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [revKey, setRevKey] = useState(0);
  const versionRef = useRef(initial.version);
  const canWrite = allowed('blog.write');
  const canPublish = allowed('blog.publish');
  const live = base.live || base.status === 'SCHEDULED';
  const editable = canWrite && base.status !== 'ARCHIVED' && (!live || canPublish);

  const update = (patch: Partial<BlogArticleInput>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setSave({ kind: 'dirty' });
  };

  const applied = (a: ApiBlogArticle, toastMessage: (() => void) | null) => {
    versionRef.current = a.version;
    setBase(a);
    setDraft(a.article);
    setSave({ kind: 'saved', at: a.updatedAt });
    setRevKey((k) => k + 1);
    toastMessage?.();
  };

  const doSave = async (autosave: boolean) => {
    setSave({ kind: 'saving' });
    try {
      const a = await studioApi.save(base.id, draft, versionRef.current, autosave);
      versionRef.current = a.version;
      setBase(a);
      setSave({ kind: 'saved', at: a.updatedAt });
      if (!autosave) {
        setRevKey((k) => k + 1);
        notify.blogSaved();
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') setSave({ kind: 'conflict' });
      else setSave({ kind: 'error', message: errorText(e) });
    }
  };

  // Drafts save themselves shortly after the last change.
  useEffect(() => {
    if (save.kind !== 'dirty' || live || !editable) return;
    const timer = setTimeout(() => void doSave(true), AUTOSAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, save.kind, live, editable]);

  // The editorial checks, as the article is written (nothing is saved by them).
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      studioApi.checks(draft).then(
        (list) => current && setIssues(list),
        () => undefined,
      );
    }, CHECK_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [draft]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (save.kind !== 'dirty') return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [save.kind]);

  const act = async (fn: () => Promise<ApiBlogArticle | null>, done: (() => void) | null) => {
    setBusy(true);
    setActionError(null);
    try {
      if (save.kind === 'dirty' && !live) await doSave(true);
      const a = await fn();
      if (a) applied(a, done);
      else done?.();
    } catch (e) {
      setActionError(errorText(e));
      if (e instanceof ApiError && e.code === 'CONFLICT') setSave({ kind: 'conflict' });
    } finally {
      setBusy(false);
    }
  };
  const move = (
    to: BlogStatus,
    confirmText: string | null,
    toast: () => void,
    publishAt: string | null = null,
  ) => {
    if (save.kind === 'dirty' && live) {
      setActionError('Update or discard your changes first.');
      return;
    }
    if (confirmText && !window.confirm(confirmText)) return;
    void act(() => studioApi.status(base.id, to, versionRef.current, publishAt), toast);
  };

  const errors = blockingIssues(issues);
  const publicPath = `/blog/${base.slug}`;
  const slugChangedLive = base.firstPublishedAt !== null && draft.slug !== base.slug;
  const id = useId();

  return (
    <div className={styles.editor}>
      <div className={styles.editorHead}>
        <p>
          <a
            href={STUDIO_PATH}
            onClick={(e) => {
              e.preventDefault();
              if (save.kind === 'dirty' && !window.confirm('Leave without saving your changes?'))
                return;
              go(STUDIO_PATH);
            }}
          >
            ← Articles
          </a>
        </p>
        <div className={styles.row}>
          <StatusBadge status={base.status} live={base.live} />
          <SaveIndicator state={save} live={live} />
          <a href={base.previewUrl} target="_blank" rel="noopener">
            Preview
          </a>
          {base.live && (
            <a href={publicPath} target="_blank" rel="noopener">
              View live
            </a>
          )}
        </div>
      </div>
      {save.kind === 'conflict' && (
        <p className={styles.error} role="alert">
          This article was changed elsewhere (another tab or editor). Your changes are still here;
          copy anything you need, then{' '}
          <button type="button" onClick={() => window.location.reload()}>
            reload
          </button>
          .
        </p>
      )}
      {live && (
        <p className={styles.liveNote} role="note">
          {base.live ? 'This article is public.' : 'This article is scheduled.'} Changes are saved
          only when you click {base.live ? 'Update' : 'Save'}, and then
          {base.live ? ' go live at once.' : ' are what goes live.'}
        </p>
      )}

      <div className={styles.editorGrid}>
        <div className={styles.editorMain}>
          <label className={styles.field}>
            Title (the page’s H1)
            <input
              className={styles.titleInput}
              value={draft.title}
              maxLength={BLOG_LIMITS.title}
              disabled={!editable}
              onChange={(e) => update({ title: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            URL slug
            <span className={styles.prefixed}>
              <span>veyrafy.com/blog/</span>
              <input
                value={draft.slug}
                maxLength={80}
                disabled={!editable}
                onChange={(e) => update({ slug: e.target.value.toLowerCase() })}
              />
            </span>
            <span className={styles.hintRow}>
              <button
                type="button"
                disabled={!editable}
                onClick={() => update({ slug: slugify(draft.title) })}
              >
                Make from title
              </button>
              {slugChangedLive && (
                <span className={styles.warnText}>
                  This article has been public: saving adds a permanent redirect from the old
                  address.
                </span>
              )}
            </span>
          </label>
          <Counted
            label="Excerpt (shown on the blog and in previews)"
            value={draft.excerpt}
            max={BLOG_LIMITS.excerpt}
            ideal={[120, 220]}
            rows={3}
            disabled={!editable}
            onChange={(v) => update({ excerpt: v })}
          />

          <h2 className={styles.sectionTitle}>Content</h2>
          <p className={styles.muted}>
            Formatting in text: <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>,{' '}
            <code>[link text](/blog/slug)</code>. Editorial notes are never published, and an
            article with notes cannot be published.
          </p>
          <Blocks
            blocks={draft.blocks}
            media={media}
            disabled={!editable}
            onChange={(blocks) => update({ blocks })}
          />

          <h2 className={styles.sectionTitle}>Frequently asked questions (optional)</h2>
          <FaqEditor faq={draft.faq} disabled={!editable} onChange={(faq) => update({ faq })} />
        </div>

        <aside className={styles.editorSide} aria-label="Publishing and SEO">
          <Panel title="Publish">
            <p className={styles.muted}>
              {base.status === 'SCHEDULED' && `Goes live ${when(base.publishedAt)}.`}
              {base.status === 'PUBLISHED' &&
                `Published ${when(base.publishedAt)}${base.contentUpdatedAt ? `, updated ${when(base.contentUpdatedAt)}` : ''}.`}
              {(base.status === 'DRAFT' || base.status === 'IN_REVIEW') && 'Not public.'}
              {base.status === 'ARCHIVED' && 'Archived: its address answers “gone”.'}
            </p>
            {actionError && (
              <p className={styles.error} role="alert">
                {actionError}
              </p>
            )}
            <div className={styles.actions}>
              {editable && (
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy || save.kind === 'saving' || (live && errors.length > 0)}
                  onClick={() => void doSave(false)}
                >
                  {base.live ? 'Update' : 'Save'}
                </button>
              )}
              {canWrite && base.status === 'DRAFT' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => move('IN_REVIEW', null, () => notify.blogStatus('in review'))}
                >
                  Send for review
                </button>
              )}
              {canWrite && base.status === 'IN_REVIEW' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => move('DRAFT', null, () => notify.blogStatus('draft'))}
                >
                  Back to draft
                </button>
              )}
              {canPublish &&
                (base.status === 'DRAFT' ||
                  base.status === 'IN_REVIEW' ||
                  base.status === 'SCHEDULED') && (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={busy || errors.length > 0}
                    onClick={() =>
                      move(
                        'PUBLISHED',
                        `Publish now? It will be public at veyrafy.com${publicPath}.`,
                        () => notify.blogStatus('published'),
                      )
                    }
                  >
                    Publish now
                  </button>
                )}
            </div>
            {canPublish && (base.status === 'DRAFT' || base.status === 'IN_REVIEW') && (
              <div className={styles.schedule}>
                <label className={styles.field}>
                  Schedule for (your local time)
                  <input
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || !scheduleAt || errors.length > 0}
                  onClick={() =>
                    move(
                      'SCHEDULED',
                      null,
                      () => notify.blogStatus('scheduled'),
                      new Date(scheduleAt).toISOString(),
                    )
                  }
                >
                  Schedule
                </button>
              </div>
            )}
            {errors.length > 0 &&
              canPublish &&
              base.status !== 'PUBLISHED' &&
              base.status !== 'ARCHIVED' && (
                <p className={styles.warnText}>
                  Fix the {errors.length} error{errors.length === 1 ? '' : 's'} below to publish.
                </p>
              )}
            <div className={styles.actions}>
              {canPublish && base.status === 'SCHEDULED' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    move('DRAFT', 'Unschedule? It goes back to draft and will not go live.', () =>
                      notify.blogStatus('draft'),
                    )
                  }
                >
                  Unschedule
                </button>
              )}
              {canPublish && base.status === 'PUBLISHED' && (
                <button
                  type="button"
                  className={styles.danger}
                  disabled={busy}
                  onClick={() =>
                    move(
                      'DRAFT',
                      'Unpublish? Readers and search engines will get “not found” at its address until it is published again.',
                      () => notify.blogStatus('draft'),
                    )
                  }
                >
                  Unpublish
                </button>
              )}
              {canPublish && base.status !== 'ARCHIVED' && (
                <button
                  type="button"
                  className={styles.danger}
                  disabled={busy}
                  onClick={() =>
                    move(
                      'ARCHIVED',
                      'Archive this article? It is withdrawn; if it was published, its address answers “gone”.',
                      () => notify.blogStatus('archived'),
                    )
                  }
                >
                  Archive
                </button>
              )}
              {canWrite && base.status === 'ARCHIVED' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => move('DRAFT', null, () => notify.blogStatus('draft'))}
                >
                  Move back to draft
                </button>
              )}
              {canWrite && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      async () => {
                        const copy = await studioApi.duplicate(base.id);
                        go(`${STUDIO_PATH}/articles/${copy.id}`);
                        return null;
                      },
                      () => notify.blogCreated(),
                    )
                  }
                >
                  Duplicate
                </button>
              )}
              {canWrite &&
                !base.firstPublishedAt &&
                base.status !== 'PUBLISHED' &&
                base.status !== 'SCHEDULED' && (
                  <button
                    type="button"
                    className={styles.danger}
                    disabled={busy}
                    onClick={() => {
                      if (
                        !window.confirm(
                          'Delete this draft? It has never been public. It is removed from the studio.',
                        )
                      )
                        return;
                      void act(
                        async () => {
                          await studioApi.remove(base.id, versionRef.current);
                          go(STUDIO_PATH);
                          return null;
                        },
                        () => notify.blogChanged(),
                      );
                    }}
                  >
                    Delete draft
                  </button>
                )}
            </div>
          </Panel>

          <Panel title={`Checks${issues.length ? ` (${issues.length})` : ''}`}>
            <Checks issues={issues} />
            <p className={styles.muted}>Editorial guidance only: no score predicts ranking.</p>
          </Panel>

          <Panel title="Search appearance">
            <SerpPreview
              title={draft.seoTitle || draft.title}
              slug={draft.slug}
              description={draft.metaDescription || draft.excerpt}
            />
            <Counted
              label="SEO title"
              value={draft.seoTitle ?? ''}
              max={BLOG_LIMITS.seoTitle}
              ideal={[30, 60]}
              placeholder={draft.title}
              disabled={!editable}
              onChange={(v) => update({ seoTitle: v || null })}
            />
            <Counted
              label="Meta description"
              value={draft.metaDescription ?? ''}
              max={BLOG_LIMITS.metaDescription}
              ideal={[120, 155]}
              rows={3}
              placeholder={draft.excerpt}
              disabled={!editable}
              onChange={(v) => update({ metaDescription: v || null })}
            />
            <label className={styles.field}>
              Focus phrase (guidance only, never shown)
              <input
                value={draft.focusKeyword ?? ''}
                maxLength={120}
                disabled={!editable}
                onChange={(e) => update({ focusKeyword: e.target.value || null })}
              />
            </label>
            <label className={styles.field}>
              Canonical URL (leave empty: this page)
              <input
                type="url"
                value={draft.canonicalUrl ?? ''}
                maxLength={500}
                placeholder={`https://veyrafy.com/blog/${draft.slug}`}
                disabled={!editable}
                onChange={(e) => update({ canonicalUrl: e.target.value || null })}
              />
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={draft.noindex}
                disabled={!editable}
                onChange={(e) => update({ noindex: e.target.checked })}
              />{' '}
              Ask search engines not to index it (noindex)
            </label>
          </Panel>

          <Panel title="Social sharing">
            <label className={styles.field}>
              Share title (empty: the SEO title)
              <input
                value={draft.ogTitle ?? ''}
                maxLength={BLOG_LIMITS.seoTitle}
                disabled={!editable}
                onChange={(e) => update({ ogTitle: e.target.value || null })}
              />
            </label>
            <label className={styles.field}>
              Share description (empty: the meta description)
              <textarea
                rows={2}
                value={draft.ogDescription ?? ''}
                maxLength={BLOG_LIMITS.metaDescription}
                disabled={!editable}
                onChange={(e) => update({ ogDescription: e.target.value || null })}
              />
            </label>
            <MediaSelect
              label="Share image (empty: the featured image)"
              value={draft.ogImageId}
              media={media}
              disabled={!editable}
              onChange={(v) => update({ ogImageId: v })}
            />
            <label className={styles.field}>
              X (Twitter) card
              <select
                value={draft.twitterCard}
                disabled={!editable}
                onChange={(e) =>
                  update({ twitterCard: e.target.value as BlogArticleInput['twitterCard'] })
                }
              >
                <option value="summary_large_image">Large image</option>
                <option value="summary">Small image</option>
              </select>
            </label>
          </Panel>

          <Panel title="Organisation">
            <label className={styles.field}>
              Author
              <select
                value={draft.authorId ?? ''}
                disabled={!editable}
                onChange={(e) => update({ authorId: e.target.value || null })}
              >
                <option value="">Choose…</option>
                {tax.authors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Category
              <select
                value={draft.categoryId ?? ''}
                disabled={!editable}
                onChange={(e) => update({ categoryId: e.target.value || null })}
              >
                <option value="">Choose…</option>
                {tax.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className={styles.fieldset}>
              <legend>Tags</legend>
              {tax.tags.length === 0 && (
                <p className={styles.muted}>No tags yet (add them under Categories & tags).</p>
              )}
              {tax.tags.map((t) => (
                <label key={t.id} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={draft.tagIds.includes(t.id)}
                    disabled={!editable}
                    onChange={(e) =>
                      update({
                        tagIds: e.target.checked
                          ? [...draft.tagIds, t.id]
                          : draft.tagIds.filter((x) => x !== t.id),
                      })
                    }
                  />{' '}
                  {t.name}
                </label>
              ))}
            </fieldset>
            <label className={styles.field}>
              Call to action at the end
              <select
                value={draft.cta}
                disabled={!editable}
                onChange={(e) => update({ cta: e.target.value as BlogArticleInput['cta'] })}
              >
                <option value="challenge">The 5 Invoice Challenge</option>
                <option value="demo">Request access</option>
                <option value="none">None</option>
              </select>
            </label>
          </Panel>

          <Panel title="Featured image">
            <MediaSelect
              label="Image"
              value={draft.featuredMediaId}
              media={media}
              disabled={!editable}
              onChange={(v) => {
                const m = media.find((x) => x.id === v);
                update({ featuredMediaId: v, featuredAlt: draft.featuredAlt ?? (m?.alt || null) });
              }}
            />
            <label className={styles.field}>
              Alt text
              <input
                value={draft.featuredAlt ?? ''}
                maxLength={300}
                disabled={!editable}
                onChange={(e) => update({ featuredAlt: e.target.value || null })}
              />
            </label>
            {editable && (
              <details>
                <summary>Upload a new image</summary>
                <MediaUpload
                  onDone={(m) => {
                    reloadMedia();
                    update({ featuredMediaId: m.id, featuredAlt: m.alt || null });
                  }}
                />
              </details>
            )}
          </Panel>

          <Panel title="Revisions">
            <Revisions
              key={revKey}
              articleId={base.id}
              disabled={!editable}
              onRestore={(revisionId, version) => {
                if (
                  !window.confirm(
                    `Restore version ${version}? Its content replaces the current content (as a new version; nothing is lost).`,
                  )
                )
                  return;
                void act(
                  () => studioApi.restore(base.id, revisionId, versionRef.current),
                  () => notify.blogChanged(),
                );
              }}
            />
          </Panel>

          <Panel title="History">
            <EventList key={revKey} articleId={base.id} />
          </Panel>
          <p className={styles.muted} id={id}>
            Created {when(base.createdAt)} · version {base.version}
          </p>
        </aside>
      </div>
    </div>
  );
}

function SaveIndicator({ state, live }: { state: SaveState; live: boolean }) {
  const text =
    state.kind === 'saved'
      ? `Saved ${when(state.at)}`
      : state.kind === 'saving'
        ? 'Saving…'
        : state.kind === 'dirty'
          ? live
            ? 'Unsaved changes'
            : 'Unsaved changes (saving shortly)'
          : state.kind === 'conflict'
            ? 'Not saved: changed elsewhere'
            : `Not saved: ${state.message}`;
  return (
    <span
      className={
        state.kind === 'error' || state.kind === 'conflict' ? styles.warnText : styles.muted
      }
      role="status"
      aria-live="polite"
    >
      {text}
    </span>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function Counted({
  label,
  value,
  max,
  ideal,
  rows,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  ideal: [number, number];
  rows?: number;
  placeholder?: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const n = value.length;
  const tone =
    n === 0 ? styles.muted : n < ideal[0] || n > ideal[1] ? styles.warnText : styles.goodText;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {rows ? (
        <textarea
          id={id}
          rows={rows}
          value={value}
          maxLength={max}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-n`}
        />
      ) : (
        <input
          id={id}
          value={value}
          maxLength={max}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-n`}
        />
      )}
      <span id={`${id}-n`} className={tone}>
        {n} characters (typical: {ideal[0]}–{ideal[1]})
      </span>
    </div>
  );
}

/** Roughly how a search result may look (search engines decide what they actually show). */
function SerpPreview({
  title,
  slug,
  description,
}: {
  title: string;
  slug: string;
  description: string;
}) {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  const full = /veyrafy/i.test(title) ? title : `${title} | Veyrafy`;
  return (
    <figure className={styles.serp} aria-label="Search result preview">
      <div className={styles.serpUrl}>veyrafy.com › blog › {slug || '…'}</div>
      <div className={styles.serpTitle}>{cut(full, 60) || 'Add a title'}</div>
      <div className={styles.serpDesc}>
        {cut(description, 158) || 'Add a meta description or an excerpt.'}
      </div>
      <figcaption className={styles.muted}>
        An approximation: search engines choose the title and snippet they show.
      </figcaption>
    </figure>
  );
}

function Checks({ issues }: { issues: BlogIssue[] }) {
  if (issues.length === 0) return <p className={styles.goodText}>No problems found.</p>;
  const order = { error: 0, warning: 1, info: 2 } as const;
  return (
    <ul className={styles.checks}>
      {[...issues]
        .sort((a, b) => order[a.level] - order[b.level])
        .map((i, n) => (
          <li key={`${i.field}-${n}`} data-level={i.level}>
            <strong>
              {i.level === 'error' ? 'Must fix' : i.level === 'warning' ? 'Warning' : 'Note'}:
            </strong>{' '}
            {i.message}
          </li>
        ))}
    </ul>
  );
}

function MediaSelect({
  label,
  value,
  media,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  media: ApiBlogMedia[];
  disabled: boolean;
  onChange: (v: string | null) => void;
}) {
  const selected = media.find((m) => m.id === value);
  return (
    <div className={styles.field}>
      <label>
        {label}
        <select
          value={value ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">None</option>
          {media.map((m) => (
            <option key={m.id} value={m.id}>
              {m.alt || 'Image without alt text'} ({m.width}×{m.height})
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <img
          className={styles.thumb}
          src={selected.url}
          alt=""
          width={selected.width}
          height={selected.height}
        />
      )}
    </div>
  );
}

function Revisions({
  articleId,
  disabled,
  onRestore,
}: {
  articleId: string;
  disabled: boolean;
  onRestore: (id: string, version: number) => void;
}) {
  const revs = useLoad(() => studioApi.revisions(articleId), `revisions:${articleId}`);
  return (
    <ol className={styles.events}>
      {revs.data?.map((r, i) => (
        <li key={r.id}>
          <strong>Version {r.version}</strong> · {r.reason}
          <span className={styles.muted}>
            {' '}
            · {r.createdBy ?? 'Veyrafy'} · {when(r.createdAt)} · {statusLabel(r.status)}
          </span>
          {i > 0 && !disabled && (
            <>
              {' '}
              <button type="button" onClick={() => onRestore(r.id, r.version)}>
                Restore
              </button>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

// ── Blocks ──────────────────────────────────────────────────────────────────

function Blocks({
  blocks,
  media,
  disabled,
  onChange,
}: {
  blocks: BlogBlock[];
  media: ApiBlogMedia[];
  disabled: boolean;
  onChange: (b: BlogBlock[]) => void;
}) {
  const [adding, setAdding] = useState<BlogBlock['type']>('paragraph');
  const set = (i: number, b: BlogBlock) => onChange(blocks.map((x, n) => (n === i ? b : x)));
  const moveBlock = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    const a = next[i];
    const b = next[j];
    if (!a || !b) return;
    next[i] = b;
    next[j] = a;
    onChange(next);
  };
  const remove = (i: number) => {
    const b = blocks[i];
    const empty =
      !b ||
      ('text' in b && !b.text.trim()) ||
      (b.type === 'list' && b.items.every((x) => !x.trim()));
    if (
      !empty &&
      !window.confirm(
        `Remove this ${b ? blockLabel(b).toLowerCase() : 'block'}? (Earlier versions stay in Revisions.)`,
      )
    )
      return;
    onChange(blocks.filter((_, n) => n !== i));
  };
  return (
    <div className={styles.blocks}>
      {blocks.map((b, i) => (
        <div key={i} className={styles.block} data-type={b.type}>
          <div className={styles.blockHead}>
            <span>{blockLabel(b)}</span>
            {!disabled && (
              <span className={styles.blockTools}>
                <button
                  type="button"
                  aria-label={`Move block ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => moveBlock(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move block ${i + 1} down`}
                  disabled={i === blocks.length - 1}
                  onClick={() => moveBlock(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove block ${i + 1}`}
                  onClick={() => remove(i)}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
          <BlockFields
            block={b}
            media={media}
            disabled={disabled}
            index={i}
            onChange={(nb) => set(i, nb)}
          />
        </div>
      ))}
      {!disabled && (
        <div className={styles.row}>
          <label>
            <span className={styles.sr}>Block type</span>
            <select value={adding} onChange={(e) => setAdding(e.target.value as BlogBlock['type'])}>
              {BLOCK_TYPES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              const t = BLOCK_TYPES.find((x) => x.type === adding);
              if (t) onChange([...blocks, t.make()]);
            }}
          >
            Add block
          </button>
        </div>
      )}
    </div>
  );
}

/** A textarea with buttons that wrap the selection in inline markup. */
function RichText({
  value,
  disabled,
  label,
  rows = 4,
  onChange,
}: {
  value: string;
  disabled: boolean;
  label: string;
  rows?: number;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const wrap = (before: string, after: string, fallback: string) => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const picked = value.slice(s, e) || fallback;
    onChange(value.slice(0, s) + before + picked + after + value.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, s + before.length + picked.length);
    });
  };
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {!disabled && (
        <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
          <button type="button" onClick={() => wrap('**', '**', 'bold text')}>
            <strong>B</strong>
            <span className={styles.sr}>Bold</span>
          </button>
          <button type="button" onClick={() => wrap('*', '*', 'italic text')}>
            <em>I</em>
            <span className={styles.sr}>Italic</span>
          </button>
          <button type="button" onClick={() => wrap('[', '](/blog/)', 'link text')}>
            Link
          </button>
          <button type="button" onClick={() => wrap('`', '`', 'code')}>
            Code
          </button>
        </div>
      )}
      <textarea
        id={id}
        ref={ref}
        rows={rows}
        value={value}
        disabled={disabled}
        maxLength={BLOG_LIMITS.blockText}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function BlockFields({
  block: b,
  media,
  disabled,
  index,
  onChange,
}: {
  block: BlogBlock;
  media: ApiBlogMedia[];
  disabled: boolean;
  index: number;
  onChange: (b: BlogBlock) => void;
}) {
  const n = index + 1;
  switch (b.type) {
    case 'paragraph':
      return (
        <RichText
          label={`Paragraph ${n}`}
          value={b.text}
          disabled={disabled}
          onChange={(text) => onChange({ ...b, text })}
        />
      );
    case 'note':
      return (
        <RichText
          label={`Editorial note ${n} (never published)`}
          value={b.text}
          disabled={disabled}
          rows={5}
          onChange={(text) => onChange({ ...b, text })}
        />
      );
    case 'callout':
      return (
        <>
          <label className={styles.field}>
            Style
            <select
              value={b.tone}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...b, tone: e.target.value as 'info' | 'tip' | 'warning' })
              }
            >
              <option value="info">Information</option>
              <option value="tip">Tip</option>
              <option value="warning">Warning</option>
            </select>
          </label>
          <RichText
            label={`Callout ${n}`}
            value={b.text}
            disabled={disabled}
            rows={3}
            onChange={(text) => onChange({ ...b, text })}
          />
        </>
      );
    case 'heading':
      return (
        <div className={styles.row}>
          <label>
            Level
            <select
              value={b.level}
              disabled={disabled}
              onChange={(e) => onChange({ ...b, level: Number(e.target.value) === 3 ? 3 : 2 })}
            >
              <option value={2}>H2 (section)</option>
              <option value={3}>H3 (sub-section)</option>
            </select>
          </label>
          <label className={styles.grow}>
            Heading text
            <input
              value={b.text}
              maxLength={200}
              disabled={disabled}
              onChange={(e) => onChange({ ...b, text: e.target.value })}
            />
          </label>
        </div>
      );
    case 'list':
      return (
        <>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={b.ordered}
              disabled={disabled}
              onChange={(e) => onChange({ ...b, ordered: e.target.checked })}
            />{' '}
            Numbered
          </label>
          <label className={styles.field}>
            Items (one per line)
            <textarea
              rows={Math.max(3, b.items.length + 1)}
              value={b.items.join('\n')}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...b,
                  items: e.target.value.split('\n').slice(0, BLOG_LIMITS.listItems),
                })
              }
            />
          </label>
        </>
      );
    case 'quote':
      return (
        <>
          <RichText
            label={`Quote ${n}`}
            value={b.text}
            disabled={disabled}
            rows={3}
            onChange={(text) => onChange({ ...b, text })}
          />
          <label className={styles.field}>
            Source (optional)
            <input
              value={b.cite ?? ''}
              maxLength={200}
              disabled={disabled}
              onChange={(e) => onChange({ ...b, cite: e.target.value || undefined })}
            />
          </label>
        </>
      );
    case 'image':
      return (
        <>
          <MediaSelect
            label="Image"
            value={b.mediaId || null}
            media={media}
            disabled={disabled}
            onChange={(v) =>
              onChange({
                ...b,
                mediaId: v ?? '',
                alt: b.alt || (media.find((m) => m.id === v)?.alt ?? ''),
              })
            }
          />
          <label className={styles.field}>
            Alt text (required)
            <input
              value={b.alt}
              maxLength={300}
              disabled={disabled}
              onChange={(e) => onChange({ ...b, alt: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            Caption (optional)
            <input
              value={b.caption ?? ''}
              maxLength={400}
              disabled={disabled}
              onChange={(e) => onChange({ ...b, caption: e.target.value || undefined })}
            />
          </label>
        </>
      );
    case 'table': {
      const text = [b.header, ...b.rows].map((r) => r.join(' | ')).join('\n');
      return (
        <>
          <label className={styles.field}>
            Caption (optional)
            <input
              value={b.caption ?? ''}
              maxLength={300}
              disabled={disabled}
              onChange={(e) => onChange({ ...b, caption: e.target.value || undefined })}
            />
          </label>
          <label className={styles.field}>
            Table: first line is the header row; cells separated by “ | ”
            <textarea
              rows={Math.max(3, b.rows.length + 2)}
              value={text}
              disabled={disabled}
              onChange={(e) => {
                const lines = e.target.value
                  .split('\n')
                  .map((l) => l.split('|').map((c) => c.trim()));
                const header = (lines[0] ?? ['']).slice(0, BLOG_LIMITS.tableColumns);
                const rows = lines
                  .slice(1, BLOG_LIMITS.tableRows + 1)
                  .map((r) => header.map((_, i) => r[i] ?? ''));
                onChange({ ...b, header, rows });
              }}
            />
          </label>
        </>
      );
    }
  }
}

function FaqEditor({
  faq,
  disabled,
  onChange,
}: {
  faq: BlogArticleInput['faq'];
  disabled: boolean;
  onChange: (f: BlogArticleInput['faq']) => void;
}) {
  return (
    <div className={styles.blocks}>
      {faq.map((f, i) => (
        <div key={i} className={styles.block}>
          <label className={styles.field}>
            Question {i + 1}
            <input
              value={f.q}
              maxLength={300}
              disabled={disabled}
              onChange={(e) =>
                onChange(faq.map((x, n) => (n === i ? { ...x, q: e.target.value } : x)))
              }
            />
          </label>
          <RichText
            label={`Answer ${i + 1}`}
            value={f.a}
            disabled={disabled}
            rows={3}
            onChange={(a) => onChange(faq.map((x, n) => (n === i ? { ...x, a } : x)))}
          />
          {!disabled && (
            <button
              type="button"
              onClick={() => {
                if ((f.q || f.a) && !window.confirm('Remove this question?')) return;
                onChange(faq.filter((_, n) => n !== i));
              }}
            >
              Remove question
            </button>
          )}
        </div>
      ))}
      {!disabled && faq.length < BLOG_LIMITS.faq && (
        <button type="button" onClick={() => onChange([...faq, { q: '', a: '' }])}>
          Add a question
        </button>
      )}
      <p className={styles.muted}>
        Only questions the article really answers. They are shown on the page and described to
        search engines.
      </p>
    </div>
  );
}
