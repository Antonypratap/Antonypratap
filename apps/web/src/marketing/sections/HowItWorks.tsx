import type { ReactNode } from 'react';
import { Container, Icon, Reveal, SectionHeading, StatusPill, Struck } from '../../design-system';
import styles from './HowItWorks.module.css';

/** The same invoice at each stage: what it looks like to your team. */
const STAGES: { title: string; text: string; state: ReactNode }[] = [
  {
    title: 'Arrives',
    text: 'A PDF, a scan or a photo. Invoices come in the way they already do.',
    state: <StatusPill status="received">Received</StatusPill>,
  },
  {
    title: 'Works',
    text: 'Veyrafy reads it, checks it and does the routine work your team does today.',
    state: (
      <span className={styles.struckChip}>
        <Struck struck>Check the totals</Struck>
      </span>
    ),
  },
  {
    title: 'Asks when needed',
    text: 'If something doesn’t add up, Veyrafy asks the right person. It never guesses.',
    state: <StatusPill status="attention">Needs you</StatusPill>,
  },
  {
    title: 'Ready',
    text: 'Checked, complete and ready for payment. Paying stays with you.',
    state: <StatusPill status="ready">Ready</StatusPill>,
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className={styles.section} aria-labelledby="how-title">
      <Container>
        <SectionHeading
          id="how-title"
          eyebrow="How it works"
          title="From invoice to ready."
          lede="Veyrafy works in the background. You only hear from it when a decision is yours to make."
        />
        <ol className={styles.flow}>
          {STAGES.map((s, i) => (
            <Reveal as="li" key={s.title} delay={i * 120} className={styles.stage}>
              <div className={styles.state}>{s.state}</div>
              <h3 className={styles.stageTitle}>{s.title}</h3>
              <p className={styles.stageText}>{s.text}</p>
              {i < STAGES.length - 1 && (
                <span className={styles.arrow} aria-hidden="true">
                  <Icon name="arrowRight" size={18} />
                </span>
              )}
            </Reveal>
          ))}
        </ol>
      </Container>
    </section>
  );
}
