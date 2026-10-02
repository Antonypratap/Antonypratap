import { useState } from 'react';
import type { ApiComparison } from '@veyra/shared';
import { Icon } from '../../design-system';
import styles from './ErpComparison.module.css';

type Row = ApiComparison['rows'][number];

const RESULT_LABEL: Record<Row['result'], string> = {
  match: 'Matches',
  mismatch: 'Does not match',
  not_checked: 'Not checked',
};

/**
 * The invoice checked against the ERP, value by value: what the invoice says, what the ERP says,
 * and a tick or a cross from the check that compared them. Every result comes from the server's
 * checks; nothing is compared in the browser. Differences come first, so nothing is missed.
 */
export function ErpComparison({
  comparison,
  onReject,
  onRecheck,
  busy,
}: {
  comparison: ApiComparison;
  /** Check again against the ERP receipt (after it was corrected and imported again). */
  onRecheck?: () => void;
  /**
   * Reject the invoice at once with the summary as its reason (recorded in the audit trail);
   * absent when not allowed or final.
   */
  onReject?: (reason: string) => void;
  busy?: boolean;
}) {
  const { verdict } = comparison;
  const [onlyDifferences, setOnlyDifferences] = useState(verdict === 'mismatch');
  const shown = onlyDifferences
    ? comparison.rows.filter((r) => r.result !== 'match')
    : comparison.rows;
  const sections = [...new Set(shown.map((r) => r.section))];
  const total = comparison.rows.length;

  return (
    <section className={styles.panel} data-verdict={verdict} aria-labelledby="erp-check-title">
      <header className={styles.verdict}>
        <span className={styles.seal} aria-hidden="true">
          <Icon name={verdict === 'cleared' ? 'check' : 'attention'} size={26} strokeWidth={2.4} />
        </span>
        <div className={styles.verdictText}>
          <p className={styles.eyebrow}>
            {comparison.source === 'erp_receipt'
              ? 'Checked against your ERP’s goods receipt'
              : 'Checked against your ERP'}
          </p>
          <h2 id="erp-check-title" className={styles.headline}>
            {comparison.headline}
          </h2>
          <p className={styles.summary}>{comparison.summary}</p>
        </div>
        <dl className={styles.score}>
          <div data-tone="match">
            <dt>Match</dt>
            <dd>{comparison.matched}</dd>
          </div>
          <div data-tone="mismatch">
            <dt>Differ</dt>
            <dd>{comparison.mismatched}</dd>
          </div>
          <div data-tone="not_checked">
            <dt>Open</dt>
            <dd>{comparison.notChecked}</dd>
          </div>
        </dl>
      </header>

      <div className={styles.toolbar}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={onlyDifferences}
            onChange={(e) => setOnlyDifferences(e.currentTarget.checked)}
          />
          Show only what needs attention
        </label>
        <span className={styles.count}>
          {comparison.matched} of {total} values match
        </span>
        {verdict !== 'cleared' && onRecheck && (
          <button type="button" className={styles.recheck} disabled={busy} onClick={onRecheck}>
            Re-check against the ERP
          </button>
        )}
        {verdict === 'mismatch' && onReject && (
          <button
            type="button"
            className={styles.reject}
            disabled={busy}
            onClick={() => {
              const reason =
                comparison.summary.length > 300
                  ? `${comparison.summary.slice(0, 297)}…`
                  : comparison.summary;
              onReject(reason);
            }}
          >
            Reject with this summary
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className={styles.empty}>Nothing needs attention: every value matches.</p>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">On the invoice</th>
                <th scope="col">In your ERP</th>
                <th scope="col" className={styles.resultHead}>
                  Result
                </th>
              </tr>
            </thead>
            {sections.map((section) => (
              <tbody key={section}>
                <tr className={styles.sectionRow}>
                  <th scope="rowgroup" colSpan={4}>
                    {section}
                  </th>
                </tr>
                {shown
                  .filter((r) => r.section === section)
                  .map((r) => (
                    <tr key={`${r.section}/${r.label}`} data-result={r.result}>
                      <th scope="row" className={styles.label}>
                        {r.label}
                        {r.note && r.result !== 'match' && (
                          <span className={styles.note}>{r.note}</span>
                        )}
                      </th>
                      <td className={styles.value}>{r.invoice ?? '—'}</td>
                      <td className={styles.value}>{r.erp ?? '—'}</td>
                      <td className={styles.result}>
                        <span className={styles.mark} aria-label={RESULT_LABEL[r.result]}>
                          {r.result === 'match' ? (
                            <Icon name="check" size={15} strokeWidth={2.6} />
                          ) : r.result === 'mismatch' ? (
                            <Icon name="close" size={14} strokeWidth={2.6} />
                          ) : (
                            '–'
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </section>
  );
}
