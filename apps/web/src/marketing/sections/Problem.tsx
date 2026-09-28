import { Container, Icon, StatusPill, useInView, useSequence } from '../../design-system';
import styles from './Problem.module.css';

const CHORES = [
  'Open it',
  'Check it',
  'Find the missing details',
  'Chase someone',
  'Resolve a discrepancy',
  'Move it forward',
];

/** A queue of repetitive tasks builds up; then Veyra reduces it to the one thing that needs a person. */
const QUEUE = [
  { vendor: 'Kestrel Packaging', task: 'Check it' },
  { vendor: 'Northline Logistics', task: 'Find the missing details' },
  { vendor: 'Altura Components', task: 'Open it' },
  { vendor: 'Brightwater Supplies', task: 'Resolve a discrepancy' },
  { vendor: 'Sable Office Co.', task: 'Chase someone' },
  { vendor: 'Harbor Freight Lines', task: 'Check it' },
  { vendor: 'Quill & Co.', task: 'Move it forward' },
];

export function Problem() {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.35 });
  // 1..7 rows pile up, then step 8 = Veyra simplifies the queue.
  const step = useSequence(QUEUE.length + 1, 260, inView, 200);
  const simplified = step > QUEUE.length;

  return (
    <section className={styles.section} aria-labelledby="problem-title">
      <Container className={styles.grid}>
        <div className={styles.copy}>
          <h2 id="problem-title" className={styles.title}>
            Finance shouldn&rsquo;t be a queue of invoices.
          </h2>
          <p className={styles.intro}>
            Invoices arrive every day. <span className={styles.muted}>Someone has to</span>
          </p>
          <ul className={styles.chores}>
            {CHORES.map((c) => (
              <li key={c}>{c}.</li>
            ))}
          </ul>
          <p className={styles.close}>
            The work is repetitive.
            <br />
            <strong>The consequences of getting it wrong aren&rsquo;t.</strong>
          </p>
        </div>

        <div ref={ref} className={styles.stage} data-simplified={simplified} aria-hidden="true">
          <div className={styles.queue}>
            <div className={styles.queueHead}>
              <span>Waiting on your team</span>
              <span className={styles.queueCount}>
                {simplified ? 1 : Math.min(step, QUEUE.length)}
              </span>
            </div>
            <ul className={styles.queueRows}>
              {QUEUE.map((q, i) => {
                const keep = q.vendor === 'Brightwater Supplies';
                return (
                  <li
                    key={q.vendor}
                    className={styles.queueRow}
                    data-visible={i < step}
                    data-keep={keep}
                    style={{ transitionDelay: simplified && !keep ? `${i * 40}ms` : undefined }}
                  >
                    <span className={styles.queueVendor}>{q.vendor}</span>
                    {simplified && keep ? (
                      <StatusPill status="attention">Needs a decision</StatusPill>
                    ) : (
                      <span className={styles.task}>{q.task}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className={styles.handled}>
              <span className={styles.handledIcon}>
                <Icon name="check" size={14} />
              </span>
              <span>
                <strong>6 invoices</strong> handled by Veyra
              </span>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
