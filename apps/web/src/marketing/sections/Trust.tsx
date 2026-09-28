import { Container, Icon, Reveal, SectionHeading, type IconName } from '../../design-system';
import styles from './Trust.module.css';

const PRINCIPLES: { title: string; text: string; icon: IconName }[] = [
  {
    title: 'Your rules',
    text: 'Veyra follows the way your team already checks and approves invoices.',
    icon: 'rules',
  },
  {
    title: 'Your people',
    text: 'Decisions go to the person who owns them. Veyra never makes them.',
    icon: 'person',
  },
  {
    title: 'Your systems',
    text: 'Works alongside the accounting system you already use.',
    icon: 'systems',
  },
  {
    title: 'Your audit trail',
    text: 'Every step is recorded: what Veyra did, what it asked, who decided.',
    icon: 'audit',
  },
];

export function Trust() {
  return (
    <section id="trust" className={styles.section} aria-labelledby="trust-title">
      <Container>
        <SectionHeading
          id="trust-title"
          eyebrow="Trust"
          title="Automation without losing control."
        />
        <ul className={styles.grid}>
          {PRINCIPLES.map((p, i) => (
            <Reveal as="li" key={p.title} delay={i * 80} className={styles.item}>
              <span className={styles.icon}>
                <Icon name={p.icon} size={18} />
              </span>
              <h3 className={styles.title}>{p.title}</h3>
              <p className={styles.text}>{p.text}</p>
            </Reveal>
          ))}
        </ul>
      </Container>
    </section>
  );
}
