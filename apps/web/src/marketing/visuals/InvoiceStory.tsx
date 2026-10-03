import { Icon, useSequence } from '../../design-system';
import { STORY_ROWS, STORY_STEPS, storyAt } from './invoiceStory';
import styles from './InvoiceStory.module.css';

/**
 * Hero: one malt bill goes through Veyrafy. Every check runs on its own until the one Veyrafy
 * can't wave through: less arrived than was billed. It stops, shows the amount at stake and asks;
 * the person rejects the bill before anything is paid. Plays slowly on a loop.
 *
 * Nothing in the card changes size while it plays (the rows are always there and the bottom slot
 * holds the progress line, the question and the outcome in the same place), so the page never
 * moves. Only colour and opacity animate. With reduced motion it shows the finished state.
 */
export function InvoiceStory() {
  const step = useSequence(STORY_STEPS, 1100, true, 900, 5000);
  const s = storyAt(step);
  const slot = s.decided ? 'decided' : s.question ? 'question' : 'checking';

  return (
    <figure
      className={styles.figure}
      aria-label="Illustration: Veyrafy checks a malt supplier's bill, finds that 480 kg arrived but 500 kg was billed, asks the team, and the bill is rejected before anything is paid."
    >
      <div className={styles.backdrop} aria-hidden="true" />
      <div className={styles.card} aria-hidden="true">
        <div className={styles.head}>
          <span className={styles.doc}>
            <Icon name="photo" size={16} />
          </span>
          <span className={styles.identity}>
            <span className={styles.vendor}>Malabar Malt House</span>
            <span className={styles.meta}>Pale ale malt · 500 kg</span>
          </span>
          <span className={styles.amount}>
            <span className={styles.total}>₹32,550</span>
            <span className={styles.meta}>incl. GST</span>
          </span>
        </div>

        <ol className={styles.rows}>
          {s.rows.map(({ row, status, detail }) => (
            <li key={row.id} className={styles.row} data-status={status}>
              <span className={styles.mark}>
                <span className={styles.tick}>
                  <Icon name="check" size={13} strokeWidth={2.6} />
                </span>
                <span className={styles.flag}>!</span>
              </span>
              <span className={styles.text}>
                <span className={styles.label}>{row.label}</span>
                <span className={styles.detail}>{detail}</span>
              </span>
            </li>
          ))}
        </ol>

        <div className={styles.slot} data-show={slot}>
          <div className={styles.checking}>
            <span className={styles.bar}>
              <span
                className={styles.barFill}
                style={{ transform: `scaleX(${s.checked / (STORY_ROWS.length - 1)})` }}
              />
            </span>
            <span>Checking against your accounting records…</span>
          </div>

          <div className={styles.question}>
            <p className={styles.questionLabel}>Needs your decision</p>
            <p className={styles.questionText}>
              20 kg billed but not delivered. <span className={styles.stake}>₹1,302 at stake.</span>
            </p>
            <div className={styles.questionActions}>
              <span className={styles.primary}>Reject: 20 kg short</span>
              <span className={styles.secondary}>Record 20 kg more received</span>
            </div>
          </div>

          <div className={styles.outcome}>
            <span className={styles.outcomeIcon}>
              <Icon name="check" size={18} strokeWidth={2.4} />
            </span>
            <p>
              <strong>Caught before you paid.</strong> Rejected with your reason on record. Nothing
              was recorded or paid.
            </p>
          </div>
        </div>
      </div>
      <figcaption className={styles.caption}>Illustrative example with sample data.</figcaption>
    </figure>
  );
}
