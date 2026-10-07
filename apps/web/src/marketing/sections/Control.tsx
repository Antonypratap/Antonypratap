import { Container, Icon, Reveal } from '../../design-system';
import styles from './Control.module.css';

/**
 * The value is the payment decision, not the reading. Reading (PDFs, scans, photos) is mentioned
 * last, as what makes the check possible. No guarantees: every benefit is what the checks do.
 */
const BENEFITS = [
  'Catch overbilling before payment',
  'Surface quantity and rate discrepancies',
  'Keep payment decisions evidence-based',
  'Reduce manual reconciliation for finance teams',
  'Create a clear trail from receipt to invoice to payment',
];

export function Control() {
  return (
    <section id="control" className={styles.section} aria-labelledby="control-title">
      <Container className={styles.inner}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Control, not just capture</p>
          <h2 id="control-title" className={styles.title}>
            Don’t just read invoices. <span className={styles.accent}>Control what gets paid.</span>
          </h2>
          <p className={styles.lede}>
            Reading an invoice is only the first step. The real value is knowing whether the
            supplier’s bill agrees with what you ordered and what your team actually received.
          </p>
          <p className={styles.reading}>
            Veyrafy reads PDFs, scans and phone photos, so nobody has to key the bill in. That is
            where the check starts, not where the value is.
          </p>
        </div>
        <ul className={styles.benefits}>
          {BENEFITS.map((b, i) => (
            <Reveal as="li" key={b} delay={i * 70} className={styles.benefit}>
              <span className={styles.tick} aria-hidden="true">
                <Icon name="check" size={16} strokeWidth={2.6} />
              </span>
              {b}
            </Reveal>
          ))}
        </ul>
      </Container>
    </section>
  );
}
