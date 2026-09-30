import type { ReactNode } from 'react';
import { Container, Eyebrow, Icon, StatusPill, Struck, useInView } from '../../design-system';
import styles from './Outcomes.module.css';

function LessWork({ on }: { on: boolean }) {
  const work = [
    'Keying in invoice details',
    'Checking every total',
    'Finding the matching order',
    'Chasing sign-offs',
  ];
  return (
    <ul className={styles.work}>
      {work.map((w, i) => (
        <li key={w}>
          <Struck struck={on} delay={i * 180}>
            {w}
          </Struck>
        </li>
      ))}
    </ul>
  );
}

function Attention({ on }: { on: boolean }) {
  const handled = ['Kestrel Packaging', 'Northline Logistics', 'Sable Office Co.'];
  return (
    <div className={styles.queue} data-on={on}>
      {handled.map((h) => (
        <div key={h} className={styles.quiet}>
          <span>{h}</span>
          <Icon name="check" size={14} />
        </div>
      ))}
      <div className={styles.loud}>
        <span>
          <strong>Invoice #4821</strong>
          <span className={styles.loudSub}>Brightwater Supplies</span>
        </span>
        <StatusPill status="attention">10 units short</StatusPill>
      </div>
    </div>
  );
}

function Control() {
  return (
    <div className={styles.control}>
      <p className={styles.controlQuestion}>Accept 90 units instead of 100?</p>
      <div className={styles.controlActions}>
        <span className={styles.accept}>Accept 90 units</span>
        <span className={styles.ask}>Ask the supplier</span>
      </div>
      <p className={styles.controlNote}>Veyrafy waits for your answer.</p>
    </div>
  );
}

function Row({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children: (on: boolean) => ReactNode;
}) {
  const [ref, inView] = useInView<HTMLLIElement>({ threshold: 0.45 });
  return (
    <li ref={ref} className={styles.row}>
      <div className={styles.words}>
        <h3 className={styles.rowTitle}>{title}</h3>
        <p className={styles.rowText}>{text}</p>
      </div>
      <div className={styles.fragment} aria-hidden="true">
        {children(inView)}
      </div>
    </li>
  );
}

export function Outcomes() {
  return (
    <section id="finance-teams" className={styles.section} aria-labelledby="outcomes-title">
      <Container>
        <div className={styles.head}>
          <Eyebrow>For finance teams</Eyebrow>
          <h2 id="outcomes-title" className={styles.title}>
            Your team sees what matters.{' '}
            <span className={styles.titleMuted}>Veyrafy takes care of the rest.</span>
          </h2>
        </div>
        <ol className={styles.rows}>
          <Row
            title="Less work."
            text="The reading, keying, checking and chasing behind each invoice is done before anyone opens it."
          >
            {(on) => <LessWork on={on} />}
          </Row>
          <Row
            title="More attention on what matters."
            text="Your queue holds only the invoices that genuinely need a person. Everything else is already handled."
          >
            {(on) => <Attention on={on} />}
          </Row>
          <Row
            title="Control when it counts."
            text="When something needs judgement, Veyrafy asks the right person and waits. It never decides for you."
          >
            {() => <Control />}
          </Row>
        </ol>
      </Container>
    </section>
  );
}
