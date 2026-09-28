import { Container, Eyebrow, Reveal } from '../../design-system';
import styles from './Philosophy.module.css';

const COMMITMENTS = [
  'Nothing is guessed.',
  'Nothing is hidden.',
  'Nothing moves forward without a reason.',
];

export function Philosophy() {
  return (
    <section id="principle" className={styles.section} aria-labelledby="philosophy-title">
      <Container className={styles.inner}>
        <Eyebrow tone="inverse">The Veyra principle</Eyebrow>
        <h2 id="philosophy-title" className={styles.lead}>
          When something isn&rsquo;t right, Veyra doesn&rsquo;t pretend it is.
        </h2>
        <Reveal>
          <p className={styles.statement}>
            <span className={styles.line}>
              If it&rsquo;s clear, Veyra <span className={styles.handles}>handles it.</span>
            </span>
            <span className={styles.line}>
              If it&rsquo;s not, Veyra <span className={styles.asks}>asks.</span>
            </span>
          </p>
        </Reveal>
        <Reveal delay={150} className={styles.foot}>
          <p className={styles.support}>Automation should remove work, not remove control.</p>
          <ul className={styles.commitments}>
            {COMMITMENTS.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Reveal>
      </Container>
    </section>
  );
}
