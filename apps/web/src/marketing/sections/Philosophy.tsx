import { Container, Eyebrow, Reveal } from '../../design-system';
import styles from './Philosophy.module.css';

export function Philosophy() {
  return (
    <section id="principles" className={styles.section} aria-labelledby="philosophy-title">
      <Container className={styles.inner}>
        <Eyebrow tone="inverse">Our principle</Eyebrow>
        <h2 id="philosophy-title" className={styles.lead}>
          When something isn&rsquo;t right, Veyra doesn&rsquo;t pretend it is.
        </h2>
        <Reveal>
          <p className={styles.statement}>
            <span className={styles.line}>If it&rsquo;s clear, Veyra handles it.</span>
            <span className={`${styles.line} ${styles.accent}`}>
              If it&rsquo;s not, Veyra asks.
            </span>
          </p>
        </Reveal>
        <Reveal delay={150}>
          <p className={styles.support}>Automation should remove work, not remove control.</p>
        </Reveal>
      </Container>
    </section>
  );
}
