import { Container, Icon, Reveal } from '../../design-system';
import styles from './Outcome.module.css';

/**
 * What changes for the business once Veyrafy sits before payment: the same invoice, without and
 * with Veyrafy, then the outcomes. No figures: there is no customer data to quote yet.
 */
const BEFORE = ['Invoice', 'Spreadsheets', 'Emails', 'Calls', 'Checking', 'Payment'];
const AFTER = ['Invoice + PO + GRN', 'Veyrafy', 'Match / resolve', 'Payment'];

const BEFORE_STEPS = [
  'Supplier invoice arrives',
  'Finance checks documents manually',
  'PO, GRN and invoice are in different places',
  'Differences can be missed',
  'Follow-ups and reconciliation',
  'Payment decision',
];
const AFTER_STEPS = [
  'Supplier invoice arrives',
  'PO, GRN and invoice brought together',
  'Veyrafy checks what was ordered, received and billed',
  'Differences are clearly surfaced',
  'Resolve, then re‑check',
  'Pay with confidence',
];

const OUTCOMES = [
  {
    title: 'Fewer payment surprises',
    text: 'Catch quantity, rate and invoice discrepancies before payment.',
  },
  {
    title: 'Less manual reconciliation',
    text: 'Give finance a clearer starting point instead of checking everything from scratch.',
  },
  {
    title: 'Faster exception resolution',
    text: 'Know exactly what doesn’t match and what needs attention.',
  },
  {
    title: 'Stronger payment control',
    text: 'Create a clear checkpoint between supplier billing and money leaving the business.',
  },
];

function Strip({ items }: { items: string[] }) {
  return (
    <ol className={styles.strip}>
      {items.map((s, i) => (
        <li key={s} className={s === 'Veyrafy' ? styles.veyrafy : undefined}>
          {i > 0 && (
            <span className={styles.arrow} aria-hidden="true">
              <Icon name="arrowRight" size={14} />
            </span>
          )}
          <span className={styles.chip}>{s}</span>
        </li>
      ))}
    </ol>
  );
}

export function Outcome() {
  return (
    <section id="outcome" className={styles.section} aria-labelledby="outcome-title">
      <Container>
        <div className={styles.head}>
          <p className={styles.eyebrow}>The outcome</p>
          <h2 id="outcome-title" className={styles.title}>
            What changes when Veyrafy sits before payment?
          </h2>
        </div>

        {/* The centrepiece: the same invoice's path, without and with Veyrafy. */}
        <div className={styles.paths}>
          <div className={styles.path} data-tone="before">
            <p className={styles.pathLabel}>Before Veyrafy</p>
            <Strip items={BEFORE} />
          </div>
          <div className={styles.path} data-tone="after">
            <p className={styles.pathLabel}>With Veyrafy</p>
            <Strip items={AFTER} />
          </div>
        </div>

        <p className={styles.line}>
          Less time figuring out what happened.{' '}
          <span className={styles.accent}>More confidence in what gets paid.</span>
        </p>

        <div className={styles.compare}>
          <div className={styles.side} data-tone="before">
            <h3 className={styles.sideTitle}>Without Veyrafy</h3>
            <ol className={styles.steps}>
              {BEFORE_STEPS.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
          <div className={styles.side} data-tone="after">
            <h3 className={styles.sideTitle}>With Veyrafy</h3>
            <ol className={styles.steps}>
              {AFTER_STEPS.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        </div>

        <ul className={styles.cards}>
          {OUTCOMES.map((o, i) => (
            <Reveal as="li" key={o.title} delay={i * 80} className={styles.card}>
              <h3 className={styles.cardTitle}>{o.title}</h3>
              <p className={styles.cardText}>{o.text}</p>
            </Reveal>
          ))}
        </ul>
      </Container>
    </section>
  );
}
