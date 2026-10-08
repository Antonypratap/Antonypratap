import { useRef, useState } from 'react';
import {
  REQUIRED_SOURCE_FIELDS,
  SOURCE_FIELD_LABELS,
  SOURCE_FIELDS,
  type ApiDataSource,
  type ApiSourceInspect,
  type ApiSourcePreview,
  type SourceField,
  type SourceLayout,
  type SourceMapping,
  type SourceOrigin,
} from '@veyra/shared';
import { Icon, StatusPill } from '../../design-system';
import { useAllowed } from '../../access/session';
import { notify } from '../../feedback/toasts';
import { api, ApiError } from '../api/client';
import { formatDate } from '../format';
import { hasCapability, useCapabilities } from '../state/capabilities';
import { useProductData, useResource } from '../state/data';
import base from './ErpData.module.css';
import styles from './Spreadsheets.module.css';

/**
 * Spreadsheet registers: the business's purchase or GRN register, kept in Excel, CSV or a Google
 * Sheet. The person says once which column holds which field; Veyrafy reads the register through
 * that mapping and checks every invoice against it. The server proposes and validates the
 * mapping; this screen shows what it says and never reads a value through a mapping nobody
 * confirmed.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT =
  '.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv';

async function fileOrigin(file: File): Promise<SourceOrigin> {
  if (file.size > MAX_BYTES) throw new Error('The file is larger than 5 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { kind: 'upload', filename: file.name, contentBase64: btoa(binary) };
}

const message = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;

const column = (i: number): string =>
  (i >= 26 ? column(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));

/** Picks the first file from a hidden input, as a promise. */
function usePicker() {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<((f: File | null) => void) | null>(null);
  const pick = () =>
    new Promise<File | null>((resolve) => {
      pending.current = resolve;
      input.current?.click();
    });
  const element = (
    <input
      ref={input}
      type="file"
      accept={ACCEPT}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0] ?? null;
        e.target.value = '';
        pending.current?.(f);
        pending.current = null;
      }}
    />
  );
  return { pick, element };
}

interface Draft {
  origin: SourceOrigin;
  inspect: ApiSourceInspect;
  tab: string;
  headerRow: number;
  mapping: SourceMapping;
  name: string;
  /** Editing an existing source's mapping (else: adding one). */
  editing: ApiDataSource | null;
  preview: ApiSourcePreview | null;
}

const PROBLEM: Record<'missing' | 'not_a_number', string> = {
  missing: 'is empty',
  not_a_number: 'is not a plain number (read as not held)',
};

export function Spreadsheets() {
  const { refresh } = useProductData();
  const caps = useCapabilities();
  const available = hasCapability(caps, 'erp.spreadsheet_sources');
  const canManage = useAllowed('imports.manage');
  const [reload, setReload] = useState(0);
  const { data: info, error: loadError } = useResource(
    () => api.sources.info(),
    `sources:${reload}`,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const picker = usePicker();

  const run = async (what: string, job: () => Promise<void>) => {
    setBusy(what);
    setProblem(null);
    try {
      await job();
    } catch (e) {
      setProblem(message(e, 'That did not work. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const open = async (origin: SourceOrigin, editing: ApiDataSource | null) => {
    const inspect = await api.sources.inspect(origin);
    const tab = inspect.tabs.find((t) => t.title === editing?.sheetTitle) ?? inspect.tabs[0];
    if (!tab) throw new Error('There is nothing in this spreadsheet to read.');
    setDraft({
      origin,
      inspect,
      tab: tab.title,
      headerRow: tab.headerRow,
      // Editing keeps the confirmed mapping; a new source starts from Veyrafy's proposal.
      mapping: editing && editing.sheetTitle === tab.title ? editing.mapping : tab.proposed,
      name: editing?.name ?? inspect.name.replace(/\.(xlsx|xls|csv)$/i, ''),
      editing,
      preview: null,
    });
  };

  const fromFile = (editing: ApiDataSource | null) =>
    run('file', async () => {
      const file = await picker.pick();
      if (file) await open(await fileOrigin(file), editing);
    });

  const fromLink = () =>
    run('link', async () => {
      await open({ kind: 'google_sheet', link }, null);
    });

  const done = async (saved: ApiDataSource, verb: string) => {
    notify.sourceSaved(verb, saved.lastSync?.status === 'ok');
    setDraft(null);
    setLink('');
    setReload((k) => k + 1);
    await refresh();
  };

  const sync = (s: ApiDataSource) =>
    run(`sync:${s.id}`, async () => {
      let origin: SourceOrigin | undefined;
      if (s.kind === 'upload') {
        const file = await picker.pick();
        if (!file) return;
        origin = await fileOrigin(file);
      }
      await done(await api.sources.sync(s.id, origin), 'synced');
    });

  const edit = (s: ApiDataSource) =>
    s.kind === 'google_sheet'
      ? run(`edit:${s.id}`, () =>
          open(
            {
              kind: 'google_sheet',
              link: `https://docs.google.com/spreadsheets/d/${s.spreadsheetId ?? ''}`,
            },
            s,
          ),
        )
      : fromFile(s);

  const toggle = (s: ApiDataSource) =>
    run(`toggle:${s.id}`, async () => {
      await api.sources.setEnabled(s.id, !s.enabled);
      setReload((k) => k + 1);
    });

  return (
    <div className={base.wrap}>
      {picker.element}
      <section className={base.section} aria-labelledby="sheets-title">
        <div>
          <h2 id="sheets-title" className={base.title}>
            Your register in Excel or Google Sheets
          </h2>
          <p className={base.sub}>
            If your purchase or goods-received register lives in a spreadsheet, Veyrafy checks every
            invoice against it. Show Veyrafy which column holds what, once; each sync reads the
            register the same way.
          </p>
        </div>
        {caps && !available && (
          <p className={base.note} data-testid="sheets-unavailable">
            Spreadsheet registers are not included in your Veyrafy subscription. Your Veyrafy
            contact can add them.
          </p>
        )}
        {loadError && !info && <p className={base.problem}>{loadError}</p>}
        {available && canManage && !draft && (
          <div className={styles.add}>
            <div className={styles.option}>
              <p className={base.stepTitle}>Upload Excel or CSV</p>
              <p className={base.note}>.xlsx, .xls or .csv, up to 5 MB.</p>
              <button
                type="button"
                className={base.button}
                disabled={busy !== null}
                onClick={() => void fromFile(null)}
              >
                <Icon name="spreadsheet" size={15} />
                {busy === 'file' ? 'Reading…' : 'Choose file'}
              </button>
            </div>
            <div className={styles.option}>
              <p className={base.stepTitle}>Connect a Google Sheet</p>
              {info?.google ? (
                <>
                  <p className={base.note}>
                    Share the sheet with <span className={styles.address}>{info.serviceEmail}</span>{' '}
                    as <strong>Viewer</strong>, then paste its link. Veyrafy can only read it, and
                    stops when you unshare it.
                  </p>
                  <form
                    className={styles.linkForm}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void fromLink();
                    }}
                  >
                    <label className="visually-hidden" htmlFor="sheet-link">
                      Google Sheets link
                    </label>
                    <input
                      id="sheet-link"
                      className={styles.input}
                      type="url"
                      inputMode="url"
                      placeholder="https://docs.google.com/spreadsheets/d/…"
                      value={link}
                      onChange={(e) => setLink(e.target.value)}
                    />
                    <button
                      type="submit"
                      className={base.button}
                      disabled={busy !== null || link.trim().length < 10}
                    >
                      {busy === 'link' ? 'Reading…' : 'Read sheet'}
                    </button>
                  </form>
                </>
              ) : (
                <p className={base.note}>
                  Not set up on this Veyrafy yet. Meanwhile, download the sheet as Excel (File ›
                  Download › .xlsx) and upload it.
                </p>
              )}
            </div>
          </div>
        )}
        {problem && (
          <p className={base.problem} role="alert">
            {problem}
          </p>
        )}
      </section>

      {draft && (
        <MappingStep
          draft={draft}
          busy={busy}
          onChange={(d) => setDraft({ ...d, preview: null })}
          onCheck={() =>
            void run('check', async () => {
              const preview = await api.sources.preview(draft.origin, layoutOf(draft));
              setDraft({ ...draft, preview });
            })
          }
          onSave={() =>
            void run('save', async () => {
              const saved = draft.editing
                ? await api.sources.relayout(
                    draft.editing.id,
                    layoutOf(draft),
                    draft.origin.kind === 'upload' ? draft.origin : undefined,
                  )
                : await api.sources.create(draft.origin, layoutOf(draft), draft.name.trim());
              await done(saved, draft.editing ? 'updated' : 'added');
            })
          }
          onCancel={() => {
            setDraft(null);
            setProblem(null);
          }}
        />
      )}

      {info && info.sources.length > 0 && (
        <section className={base.section} aria-labelledby="sources-title">
          <h2 id="sources-title" className={base.title}>
            Registers
          </h2>
          <ul className={styles.sources}>
            {info.sources.map((s) => (
              <li key={s.id} className={styles.source} data-enabled={s.enabled}>
                <div className={styles.sourceHead}>
                  <span className={styles.sourceName}>{s.name}</span>
                  <span className={styles.kind}>
                    {s.kind === 'google_sheet' ? 'Google Sheet' : 'Uploaded file'} · {s.sheetTitle}
                  </span>
                  {!s.enabled && <StatusPill status="neutral">Off</StatusPill>}
                </div>
                <p className={base.note}>
                  {s.records} invoice record{s.records === 1 ? '' : 's'} from this register
                  {s.kind === 'google_sheet' &&
                    s.enabled &&
                    ` · read again before checks when older than ${info.refreshMinutes} minutes`}
                </p>
                {s.lastSync && (
                  <p className={styles.sync} data-status={s.lastSync.status}>
                    <StatusPill status={s.lastSync.status === 'ok' ? 'handled' : 'attention'}>
                      {s.lastSync.status === 'ok'
                        ? 'Synced'
                        : s.lastSync.status === 'columns_changed'
                          ? 'Columns changed'
                          : 'Sync failed'}
                    </StatusPill>
                    <span>
                      {formatDate(s.lastSync.at.slice(0, 10))}: {s.lastSync.message}
                    </span>
                  </p>
                )}
                {canManage && available && (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={base.button}
                      disabled={busy !== null || !s.enabled}
                      onClick={() => void sync(s)}
                    >
                      {busy === `sync:${s.id}`
                        ? 'Syncing…'
                        : s.kind === 'upload'
                          ? 'Upload latest file'
                          : 'Sync now'}
                    </button>
                    <button
                      type="button"
                      className={styles.quiet}
                      disabled={busy !== null}
                      onClick={() => void edit(s)}
                    >
                      Edit mapping
                    </button>
                    <button
                      type="button"
                      className={styles.quiet}
                      disabled={busy !== null}
                      onClick={() => void toggle(s)}
                    >
                      {s.enabled ? 'Turn off' : 'Turn on'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const layoutOf = (d: Draft): SourceLayout => ({
  sheetTitle: d.tab,
  headerRow: d.headerRow,
  mapping: d.mapping,
});

function MappingStep({
  draft,
  busy,
  onChange,
  onCheck,
  onSave,
  onCancel,
}: {
  draft: Draft;
  busy: string | null;
  onChange: (d: Draft) => void;
  onCheck: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const tab = draft.inspect.tabs.find((t) => t.title === draft.tab) ?? draft.inspect.tabs[0];
  const columns = tab?.columns ?? [];
  const p = draft.preview;
  const missing = REQUIRED_SOURCE_FIELDS.filter((f) => draft.mapping[f] === undefined);
  const canSave =
    p !== null &&
    p.unmappedRequired.length === 0 &&
    p.invoices > 0 &&
    !p.tooMany &&
    draft.name.trim().length > 0;
  const setField = (f: SourceField, value: string) => {
    const rest = Object.fromEntries(
      Object.entries(draft.mapping).filter(([k]) => k !== f),
    ) as SourceMapping;
    onChange({ ...draft, mapping: value === '' ? rest : { ...rest, [f]: Number(value) } });
  };

  return (
    <section className={base.preview} aria-labelledby="mapping-title">
      <div className={base.previewHead}>
        <h2 id="mapping-title" className={base.previewTitle}>
          {draft.editing
            ? `Mapping for ${draft.editing.name}`
            : `Map the columns of ${draft.inspect.name}`}
        </h2>
        <button type="button" className={styles.quiet} onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div className={styles.layout}>
        {draft.inspect.tabs.length > 1 && (
          <label className={styles.labelled}>
            <span className={base.stepTitle}>Tab</span>
            <select
              className={styles.input}
              value={draft.tab}
              onChange={(e) => {
                const t = draft.inspect.tabs.find((x) => x.title === e.target.value);
                if (t)
                  onChange({ ...draft, tab: t.title, headerRow: t.headerRow, mapping: t.proposed });
              }}
            >
              {draft.inspect.tabs.map((t) => (
                <option key={t.title} value={t.title}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {!draft.editing && (
          <label className={styles.labelled}>
            <span className={base.stepTitle}>Name</span>
            <input
              className={styles.input}
              value={draft.name}
              maxLength={120}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
            />
          </label>
        )}
        <p className={base.note}>
          Column names found in row {draft.headerRow}
          {tab ? `; ${tab.rows} row${tab.rows === 1 ? '' : 's'} below it` : ''}. Veyrafy suggested a
          column for each field it recognised; check each one.
        </p>
      </div>

      <div className={base.scroll}>
        <table className={`${base.table} ${styles.mapping}`}>
          <thead>
            <tr>
              <th>Veyrafy field</th>
              <th>Column in your sheet</th>
              <th>Examples</th>
            </tr>
          </thead>
          <tbody>
            {SOURCE_FIELDS.map((f) => {
              const chosen = draft.mapping[f];
              const col = chosen === undefined ? undefined : columns[chosen];
              const required = REQUIRED_SOURCE_FIELDS.includes(f);
              return (
                <tr key={f} data-missing={required && chosen === undefined}>
                  <td>
                    <label htmlFor={`map-${f}`}>
                      {SOURCE_FIELD_LABELS[f]}
                      {required && <span className={styles.required}> (required)</span>}
                    </label>
                  </td>
                  <td>
                    <select
                      id={`map-${f}`}
                      className={styles.input}
                      value={chosen === undefined ? '' : String(chosen)}
                      onChange={(e) => setField(f, e.target.value)}
                    >
                      <option value="">Not in this sheet</option>
                      {columns.map((c) => (
                        <option key={c.index} value={c.index}>
                          {column(c.index)} · {c.header}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={styles.samples}>{col?.samples.join(' · ') ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {missing.length > 0 && (
        <p className={base.note}>
          Choose a column for {missing.map((f) => SOURCE_FIELD_LABELS[f].toLowerCase()).join(', ')}.
        </p>
      )}

      {p && (
        <div className={styles.result} aria-live="polite">
          <p>
            <strong>
              {p.invoices} invoice{p.invoices === 1 ? '' : 's'}, {p.lines} line
              {p.lines === 1 ? '' : 's'}
            </strong>{' '}
            will be read.
            {p.errorCount > 0 &&
              ` ${p.errorCount} row problem${p.errorCount === 1 ? '' : 's'}: those rows are skipped.`}
          </p>
          {p.tooMany && (
            <p className={base.problem}>
              This register has too many invoices. Keep it to the invoices being checked.
            </p>
          )}
          {[...p.errors, ...p.warnings].length > 0 && (
            <ul className={styles.problems}>
              {[...p.errors, ...p.warnings].slice(0, 20).map((e, i) => (
                <li key={i}>
                  Row {e.row}: {e.field ? SOURCE_FIELD_LABELS[e.field] : 'value'}{' '}
                  {PROBLEM[e.problem]}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className={base.actions}>
        <button
          type="button"
          className={styles.quiet}
          disabled={busy !== null || missing.length > 0}
          onClick={onCheck}
        >
          {busy === 'check' ? 'Checking…' : 'Check mapping'}
        </button>
        <button
          type="button"
          className={base.button}
          disabled={busy !== null || !canSave}
          onClick={onSave}
        >
          {busy === 'save' ? 'Saving…' : draft.editing ? 'Save mapping and sync' : 'Save and sync'}
        </button>
      </div>
    </section>
  );
}
