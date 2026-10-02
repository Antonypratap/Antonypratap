import { Icon, useSequence } from '../../design-system';
import { STORY_STEPS, storyAt } from './invoiceStory';
import styles from './InvoiceStory.module.css';

/**
 * Hero: one invoice goes through Veyrafy. Every check runs on its own; the one question only a
 * person can answer (did the goods arrive?) is put to the team; then the invoice is recorded in
 * the ERP. Plays on a loop; with reduced motion it shows the finished state.
 */
export function InvoiceStory() {
  const step = useSequence(STORY_STEPS, 700, true, 700, 3500);
  const s = storyAt(step);

  return (
    <figure
      className={styles.figure}
      aria-label="Illustration: Veyrafy reads an invoice, matches the supplier and the purchase order, asks the finance team to confirm the goods arrived, then records the invoice in the ERP."
    >
      <div className={styles.backdrop} aria-hidden="true" />
      <div className={styles.card} aria-hidden="true">
        <div className={styles.head}>
          <span className={styles.doc}>PDF</span>
          <span className={styles.identity}>
            <span className={styles.vendor}>Apex Components Pvt Ltd</span>
            <span className={styles.meta}>Invoice APX/26-27/1187 · 50 ball bearings</span>
          </span>
          <span className={styles.amount}>
            <span className={styles.total}>₹8,555.00</span>
            <span className={styles.meta}>incl. GST</span>
          </span>
        </div>

        <ol className={styles.rows}>
          {s.rows.map(({ row, status, detail }) => (
            <li key={row.id} className={styles.row} data-status={status}>
              <span className={styles.mark}>
                {(status === 'done' || status === 'decided') && (
                  <Icon name="check" size={13} strokeWidth={2.6} />
                )}
                {status === 'ask' && '?'}
              </span>
              <span className={styles.text}>
                <span className={styles.label}>{row.label}</span>
                <span className={styles.detail}>{detail}</span>
              </span>
              {status === 'decided' && <span className={styles.tag}>You decided</span>}
            </li>
          ))}
        </ol>

        <div className={styles.foot}>
          {s.question && (
            <div className={styles.question}>
              <p className={styles.questionLabel}>Your approval is needed</p>
              <p className={styles.questionText}>
                Did the goods arrive? 50 bearings are invoiced, and no goods receipt is recorded.
              </p>
              <div className={styles.questionActions}>
                <span className={styles.primary}>Yes, record the receipt</span>
                <span className={styles.secondary}>Not yet</span>
              </div>
            </div>
          )}
          {s.ready && (
            <div className={styles.ready}>
              <Icon name="check" size={18} strokeWidth={2.4} />
              <p>
                <strong>Invoice ready.</strong> ₹8,555.00 recorded against PO-2026-0104. Payment
                stays with you.
              </p>
            </div>
          )}
        </div>
      </div>
      <figcaption className={styles.caption}>Illustrative example with sample data.</figcaption>
    </figure>
  );
}
