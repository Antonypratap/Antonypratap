import { Container, StatusPill, Struck, useInView, useSequence } from '../../design-system';
import styles from './Problem.module.css';

/**
 * The problem, then its removal: the chores are struck out of the copy while the queue beside
 * them empties, until one invoice that needs a person is left.
 */
const QUEUE = [
  { vendor: 'Altura Components', chore: 'Open it' },
  { vendor: 'Kestrel Packaging', chore: 'Check it' },
  { vendor: 'Northline Logistics', chore: 'Find the missing details' },
  { vendor: 'Sable Office Co.', chore: 'Chase someone' },
  { vendor: 'Brightwater Supplies', chore: 'Resolve a discrepancy', keep: true },
  { vendor: 'Quill & Co.', chore: 'Move it forward' },
] as const;

export function Problem() {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.35 });
  // One step per chore taken away, then a final step where the queue settles.
  const step = useSequence(QUEUE.length + 1, 380, inView, 500, 3000);
  const settled = step > QUEUE.length;
  const waiting = QUEUE.filter((q, i) => 'keep' in q || i >= step).length;

  return (
    <section className={styles.section} aria-labelledby="problem-title">
      <Container>
        <h2 id="problem-title" className={styles.title}>
          Finance shouldn&rsquo;t be a queue of invoices.
        </h2>
        <div ref={ref} className={styles.grid}>
          <div className={styles.copy}>
            <p className={styles.intro}>Invoices arrive every day, and someone has to</p>
            <ul className={styles.chores}>
              {QUEUE.map((q, i) => (
                <li key={q.chore} data-kept={'keep' in q && step > i}>
                  <Struck struck={!('keep' in q) && step > i}>{q.chore}.</Struck>
                </li>
              ))}
            </ul>
            <p className={styles.close}>
              The work is repetitive.{' '}
              <strong>The consequences of getting it wrong aren&rsquo;t.</strong>
            </p>
          </div>

          <div className={styles.queue} data-settled={settled} aria-hidden="true">
            <div className={styles.queueHead}>
              <span>Waiting on your team</span>
              <span className={styles.queueCount} data-settled={settled}>
                {waiting}
              </span>
            </div>
            <ul className={styles.rows}>
              {QUEUE.map((q, i) => {
                const keep = 'keep' in q;
                const gone = !keep && step > i;
                return (
                  <li
                    key={q.vendor}
                    className={styles.row}
                    data-gone={gone}
                    data-keep={keep && step > i}
                  >
                    <span className={styles.vendor}>{q.vendor}</span>
                    {keep && step > i ? (
                      <StatusPill status="attention">Needs a decision</StatusPill>
                    ) : (
                      <span className={styles.chore}>
                        <Struck struck={gone}>{q.chore}</Struck>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className={styles.handled}>
              <StatusPill status="handled">5 handled by Veyrafy</StatusPill>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
