import { Card, Container, Icon, Reveal, SectionHeading, StatusPill } from '../../design-system';
import styles from './Outcomes.module.css';

function LessWork() {
  const rows = [
    'Kestrel Packaging',
    'Northline Logistics',
    'Altura Components',
    'Sable Office Co.',
  ];
  return (
    <ul className={styles.miniList} aria-hidden="true">
      {rows.map((r) => (
        <li key={r} className={styles.miniRow}>
          <span className={styles.miniName}>{r}</span>
          <StatusPill status="handled" />
        </li>
      ))}
    </ul>
  );
}

function Focus() {
  return (
    <div className={styles.focus} aria-hidden="true">
      <div className={styles.dimRow} />
      <div className={styles.focusRow}>
        <span className={styles.focusIcon}>
          <Icon name="attention" size={14} />
        </span>
        <span className={styles.miniName}>Invoice #4821</span>
        <StatusPill status="attention">1 issue</StatusPill>
      </div>
      <div className={styles.dimRow} />
      <div className={styles.dimRow} />
    </div>
  );
}

function Control() {
  return (
    <div className={styles.control} aria-hidden="true">
      <p className={styles.controlLabel}>Your decision</p>
      <p className={styles.controlQuestion}>Accept 90 units instead of 100?</p>
      <div className={styles.controlActions}>
        <span className={styles.approve}>Accept</span>
        <span className={styles.hold}>Ask the supplier</span>
      </div>
    </div>
  );
}

const OUTCOMES = [
  {
    label: 'Less manual work',
    text: 'Routine invoice work gets handled without unnecessary intervention.',
    visual: <LessWork />,
  },
  {
    label: 'Focus on what matters',
    text: 'Your team sees the invoices and issues that actually need attention.',
    visual: <Focus />,
  },
  {
    label: 'Keep control',
    text: 'Important decisions remain with your people.',
    visual: <Control />,
  },
];

export function Outcomes() {
  return (
    <section className={styles.section} aria-labelledby="outcomes-title">
      <Container>
        <SectionHeading
          id="outcomes-title"
          eyebrow="The outcome"
          title="Less processing. More control."
        />
        <div className={styles.grid}>
          {OUTCOMES.map((o, i) => (
            <Reveal key={o.label} delay={i * 90}>
              <Card className={styles.card}>
                <div className={styles.visual}>{o.visual}</div>
                <div className={styles.text}>
                  <h3 className={styles.cardTitle}>{o.label}</h3>
                  <p className={styles.cardBody}>{o.text}</p>
                </div>
              </Card>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
