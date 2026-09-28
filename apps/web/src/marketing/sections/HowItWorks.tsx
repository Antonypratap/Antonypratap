import { Container, Icon, Reveal, SectionHeading, type IconName } from '../../design-system';
import styles from './HowItWorks.module.css';

const STEPS: { n: string; title: string; text: string; icon: IconName }[] = [
  {
    n: '01',
    title: 'Receive',
    text: 'Invoices come in the way they do today: PDFs, scans, photos.',
    icon: 'inbox',
  },
  {
    n: '02',
    title: 'Understand',
    text: 'Veyra reads each one and knows what it should look like.',
    icon: 'document',
  },
  {
    n: '03',
    title: 'Resolve',
    text: 'The routine gets settled. Real decisions go to your team.',
    icon: 'person',
  },
  {
    n: '04',
    title: 'Ready',
    text: 'Invoices move forward, complete and accounted for.',
    icon: 'check',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className={styles.section} aria-labelledby="how-title">
      <Container>
        <SectionHeading
          id="how-title"
          eyebrow="How it works"
          title="From invoice to done."
          lede="Veyra works quietly in the background, handling the routine work and bringing your team in only when a decision is needed."
        />
        <ol className={styles.steps}>
          {STEPS.map((s, i) => (
            <Reveal as="li" key={s.n} delay={i * 110} className={styles.step}>
              <div className={styles.marker}>
                <span className={styles.icon}>
                  <Icon name={s.icon} size={18} />
                </span>
                <span className={styles.line} aria-hidden="true" />
              </div>
              <p className={styles.n}>{s.n}</p>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepText}>{s.text}</p>
            </Reveal>
          ))}
        </ol>
      </Container>
    </section>
  );
}
