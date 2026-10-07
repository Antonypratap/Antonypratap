import { Container, Reveal, SectionHeading } from '../../design-system';
import styles from './HowItWorks.module.css';

/**
 * The real process, with who does each step: the store records the goods, finance receives the
 * bill, Veyrafy checks and flags, and your team resolves and releases payment. Veyrafy never pays.
 */
const STEPS: { title: string; text: string; who: string; control?: boolean }[] = [
  {
    title: 'Goods arrive',
    text: 'Store / facility checks quantity and records the GRN.',
    who: 'Your store team',
  },
  {
    title: 'Supplier sends invoice',
    text: 'Finance receives the supplier’s bill.',
    who: 'Your finance team',
  },
  {
    title: 'Veyrafy checks',
    text: 'Invoice is checked against available PO, GRN and reference data.',
    who: 'Veyrafy',
    control: true,
  },
  {
    title: 'Differences are flagged',
    text: 'Quantity, rate, tax, totals or other discrepancies are surfaced with evidence.',
    who: 'Veyrafy, to the person who decides',
    control: true,
  },
  {
    title: 'Payment stays in control',
    text: 'Resolve the discrepancy, re\u2011check, then release payment.',
    who: 'Your team',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className={styles.section} aria-labelledby="how-title">
      <Container>
        <SectionHeading
          id="how-title"
          eyebrow="How it works"
          title={'From goods received to payment\u00a0— with a control point in between.'}
        />
        <ol className={styles.flow}>
          {STEPS.map((s, i) => (
            <Reveal
              as="li"
              key={s.title}
              delay={i * 100}
              className={s.control ? `${styles.stage} ${styles.control}` : styles.stage}
            >
              <span className={styles.num}>{String(i + 1).padStart(2, '0')}</span>
              <h3 className={styles.stageTitle}>{s.title}</h3>
              <p className={styles.stageText}>{s.text}</p>
              <p className={styles.who}>{s.who}</p>
            </Reveal>
          ))}
        </ol>
      </Container>
    </section>
  );
}
