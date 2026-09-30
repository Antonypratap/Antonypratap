import { useRef, useState } from 'react';
import type { ApiImport } from '@veyra/shared';
import { Icon } from '../../design-system';
import { api, ApiError, exportUrl, TEMPLATES, templateUrl } from '../api/client';
import { formatDate } from '../format';
import { hrefFor } from '../router';
import { useProductData, useResource } from '../state/data';
import { hasCapability, useCapabilities } from '../state/capabilities';
import styles from './ErpData.module.css';
import { notify } from '../../feedback/toasts';

/**
 * Import and export business records (Phase 3C): download a template, fill it in, upload, check
 * the preview, confirm. The server validates everything; this screen only shows what it says.
 */
export function ErpData() {
  const { refresh } = useProductData();
  // Commercial capabilities (Phase 8A): what this organization may use. The server enforces them;
  // this only avoids offering what would be refused.
  const caps = useCapabilities();
  const canImport = hasCapability(caps, 'erp.business_record_import');
  const canExport = hasCapability(caps, 'reports.exports');
  const input = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState<ApiImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const { data: history } = useResource(() => api.imports.list(), `imports:${historyKey}`);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setProblem(null);
    try {
      const checked = await api.imports.check(Array.from(files));
      setCurrent(checked);
      notify.importChecked(checked.status === 'ready');
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'The file could not be uploaded.');
    } finally {
      setBusy(false);
      setHistoryKey((k) => k + 1);
      if (input.current) input.current.value = '';
    }
  };

  const confirm = async () => {
    if (!current) return;
    setBusy(true);
    setProblem(null);
    try {
      setCurrent(await api.imports.confirm(current.id));
      notify.imported();
      await refresh();
    } catch (e) {
      const again = e instanceof ApiError ? (e.details.import as ApiImport | undefined) : undefined;
      if (again) setCurrent(again);
      setProblem(
        e instanceof ApiError ? e.message : 'The import did not complete. Nothing was imported.',
      );
    } finally {
      setBusy(false);
      setHistoryKey((k) => k + 1);
    }
  };

  return (
    <div className={styles.wrap}>
      <section className={styles.section} aria-labelledby="import-title">
        <div>
          <h2 id="import-title" className={styles.title}>
            Import business records
          </h2>
          <p className={styles.sub}>
            Bring in vendors, items, purchase orders and goods receipts. Use this when your ERP
            isn&rsquo;t connected: Veyrafy checks invoices against these records.
          </p>
        </div>
        {caps && !canImport && (
          <p className={styles.note} data-testid="import-unavailable">
            Importing business records is not included in your Veyrafy subscription. Your Veyrafy
            contact can add it.
          </p>
        )}
        {canImport && (
          <ol className={styles.steps}>
            <li>
              <span className={styles.stepTitle}>Download a template</span>
              <span className={styles.templates}>
                {TEMPLATES.map((t) => (
                  <a key={t.file} href={templateUrl(t.file)} download className={styles.link}>
                    {t.title}
                  </a>
                ))}
              </span>
            </li>
            <li>
              <span className={styles.stepTitle}>Fill it in</span>
              <span className={styles.note}>
                One row per record. Order: vendors, items, purchase orders with their lines, goods
                receipts with their lines. Lines go in the same upload as their order or receipt.
              </span>
            </li>
            <li>
              <span className={styles.stepTitle}>Upload it</span>
              <span className={styles.note}>
                Excel (.xlsx) or CSV. Veyrafy checks the whole upload before anything is imported.
              </span>
              <span>
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy}
                  onClick={() => input.current?.click()}
                >
                  <Icon name="document" size={15} />
                  {busy && !current ? 'Checking…' : 'Upload records'}
                </button>
                <input
                  ref={input}
                  type="file"
                  accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                  multiple
                  hidden
                  onChange={(e) => void upload(e.target.files)}
                />
              </span>
            </li>
          </ol>
        )}
        {problem && !current && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
      </section>

      {current && canImport && (
        <Preview
          current={current}
          busy={busy}
          problem={problem}
          onConfirm={() => void confirm()}
          onClose={() => setCurrent(null)}
        />
      )}

      <section className={styles.section} aria-labelledby="export-title">
        <h2 id="export-title" className={styles.title}>
          Export
        </h2>
        {caps && !canExport && (
          <p className={styles.note} data-testid="export-unavailable">
            Exports are not included in your Veyrafy subscription.
          </p>
        )}
        {canExport && (
          <ul className={styles.exports}>
            <li>
              <span>Business records</span>
              <a className={styles.link} href={exportUrl('business-records.xlsx')} download>
                .xlsx
              </a>
              <span className={styles.note}>In the import format</span>
            </li>
            {(
              [
                ['invoices', 'Processed invoices'],
                ['decisions', 'Decisions'],
                ['audit', 'Audit trail'],
              ] as const
            ).map(([name, label]) => (
              <li key={name}>
                <span>{label}</span>
                <a className={styles.link} href={exportUrl(`${name}.xlsx`)} download>
                  .xlsx
                </a>
                <a className={styles.link} href={exportUrl(`${name}.csv`)} download>
                  .csv
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {history && history.length > 0 && (
        <section className={styles.section} aria-labelledby="history-title">
          <h2 id="history-title" className={styles.title}>
            Import history
          </h2>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th className={styles.num}>Records</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.files.join(', ')}</td>
                    <td>{h.kinds}</td>
                    <td>{formatDate(h.createdAt.slice(0, 10))}</td>
                    <td className={styles.num}>{h.tables.reduce((n, t) => n + t.rows, 0)}</td>
                    <td data-result={h.status}>{resultText(h)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function resultText(h: ApiImport): string {
  if (h.status === 'imported') {
    const added = h.result ? Object.values(h.result.created).reduce((a, b) => a + b, 0) : 0;
    return added ? `Imported (${added} added)` : 'Imported (nothing new)';
  }
  if (h.status === 'invalid')
    return `Not imported (${h.errorCount} ${h.errorCount === 1 ? 'problem' : 'problems'})`;
  return 'Checked, not imported yet';
}

function Preview({
  current,
  busy,
  problem,
  onConfirm,
  onClose,
}: {
  current: ApiImport;
  busy: boolean;
  problem: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const imported = current.status === 'imported';
  const ready = current.tables.reduce((n, t) => n + t.ready, 0);
  const created = current.result
    ? Object.values(current.result.created).reduce((a, b) => a + b, 0)
    : 0;
  const skipped = current.result
    ? Object.values(current.result.skipped).reduce((a, b) => a + b, 0)
    : 0;
  const title = imported
    ? 'Import complete'
    : current.errorCount
      ? 'Fix these and upload again'
      : 'Check before importing';

  return (
    <section
      className={styles.preview}
      data-state={imported ? 'done' : current.errorCount ? 'errors' : 'ready'}
      aria-live="polite"
      aria-labelledby="preview-title"
    >
      <div className={styles.previewHead}>
        <h2 id="preview-title" className={styles.previewTitle}>
          {title}
        </h2>
        <span className={styles.files}>{current.files.join(', ')}</span>
      </div>

      {imported ? (
        <dl className={styles.totals}>
          <div>
            <dt>Imported</dt>
            <dd>{created}</dd>
          </div>
          <div>
            <dt>Already existed</dt>
            <dd>{skipped}</dd>
          </div>
          <div>
            <dt>Errors</dt>
            <dd>0</dd>
          </div>
        </dl>
      ) : (
        <ul className={styles.counts}>
          {current.tables.map((t) => (
            <li key={t.key}>
              <span className={styles.countMain}>
                <strong>{t.rows}</strong> {t.rows === 1 ? t.noun[0] : t.noun[1]}
              </span>
              <span className={styles.countParts}>
                {t.ready > 0 && (
                  <span className={styles.ok}>
                    <Icon name="check" size={13} /> {t.ready} ready
                  </span>
                )}
                {t.existing > 0 && <span>{t.existing} already exist</span>}
                {t.errors > 0 && (
                  <span className={styles.bad}>
                    {t.errors} {t.errors === 1 ? 'error' : 'errors'}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {current.errors.length > 0 && (
        <ul className={styles.errors} aria-label="Problems to fix">
          {current.errors.slice(0, 50).map((e, i) => (
            <li key={i}>
              <span className={styles.where}>
                {[e.table ?? e.file, e.row ? `Row ${e.row}` : null].filter(Boolean).join(' · ')}
              </span>
              <span>{e.message}</span>
            </li>
          ))}
          {current.errorCount > 50 && (
            <li className={styles.more}>And {current.errorCount - 50} more.</li>
          )}
        </ul>
      )}

      {current.notices.length > 0 && (
        <ul className={styles.notices}>
          {current.notices.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}

      <div className={styles.actions}>
        {!imported && current.canConfirm && (
          <button type="button" className={styles.button} disabled={busy} onClick={onConfirm}>
            {busy ? 'Importing…' : `Import ${ready} ${ready === 1 ? 'record' : 'records'}`}
          </button>
        )}
        {!imported && !current.canConfirm && (
          <p className={styles.note}>
            {current.errorCount
              ? 'Nothing has been imported. Fix these rows in your file and upload it again.'
              : 'Everything in this upload is already in your records. Nothing to import.'}
          </p>
        )}
        {imported && (
          <a className={styles.link} href={hrefFor({ name: 'erp', tab: 'vendors' })}>
            See your records
          </a>
        )}
        <button type="button" className={styles.quiet} onClick={onClose}>
          {imported ? 'Done' : 'Cancel'}
        </button>
      </div>
    </section>
  );
}
