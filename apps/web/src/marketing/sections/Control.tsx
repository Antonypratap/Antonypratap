import { Container } from '../../design-system';
import styles from './Control.module.css';

/** The positioning in one statement: the value is the payment decision, not the reading. */
export function Control() {
  return (
    <section id="control" className={styles.section} aria-labelledby="control-title">
      <Container className={styles.inner}>
        <h2 id="control-title" className={styles.title}>
          Don’t just read invoices. <span className={styles.accent}>Control what gets paid.</span>
        </h2>
        <p className={styles.lede}>
          Reading an invoice is only the first step. The real value is knowing whether the
          supplier’s bill agrees with what you ordered and what your team actually received.
        </p>
      </Container>
    </section>
  );
}
