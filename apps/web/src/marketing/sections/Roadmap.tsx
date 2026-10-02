import { Container, Icon, Reveal, SectionHeading, type IconName } from '../../design-system';
import styles from './Roadmap.module.css';

/**
 * Where Veyrafy is going: directions, not dates or details. Nothing here is promised as shipped;
 * it is labelled "In the works" and says only what each direction is for.
 */
const NEXT: { title: string; text: string; icon: IconName }[] = [
  {
    title: 'Invoices that arrive on their own',
    text: 'Fewer uploads. Supplier invoices find their way to Veyrafy the way they already reach you.',
    icon: 'inbox',
  },
  {
    title: 'More systems, connected',
    text: 'Deeper ties to the business systems Indian finance teams run on.',
    icon: 'systems',
  },
  {
    title: 'Approvals, your way',
    text: 'The right decision to the right person, however your team is organised.',
    icon: 'person',
  },
  {
    title: 'See your payables clearly',
    text: 'What is waiting, what is due and what was caught, at a glance.',
    icon: 'spark',
  },
];

export function Roadmap() {
  return (
    <section id="whats-next" className={styles.section} aria-labelledby="next-title">
      <Container>
        <SectionHeading
          id="next-title"
          eyebrow="What’s next"
          title="We’re only getting started."
          lede="Veyrafy grows with the teams who use it. Here is where it is heading."
        />
        <ul className={styles.grid}>
          {NEXT.map((n, i) => (
            <Reveal as="li" key={n.title} delay={i * 80} className={styles.item}>
              <span className={styles.badge}>In the works</span>
              <span className={styles.icon}>
                <Icon name={n.icon} size={18} />
              </span>
              <h3 className={styles.title}>{n.title}</h3>
              <p className={styles.text}>{n.text}</p>
            </Reveal>
          ))}
        </ul>
        <p className={styles.note}>
          Want a say in what comes first? Early customers shape the roadmap.
        </p>
      </Container>
    </section>
  );
}
