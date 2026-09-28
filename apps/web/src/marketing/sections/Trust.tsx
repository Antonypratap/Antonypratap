import { Container, Icon, Reveal, SectionHeading, type IconName } from '../../design-system';
import styles from './Trust.module.css';

const PRINCIPLES: { title: string; text: string; icon: IconName }[] = [
  { title: 'Your rules', text: 'Your process stays yours.', icon: 'rules' },
  { title: 'Your people', text: 'Important decisions stay with your team.', icon: 'person' },
  {
    title: 'Your systems',
    text: 'Veyra fits into the way your business already works.',
    icon: 'systems',
  },
  { title: 'Your audit trail', text: 'Know what happened and why.', icon: 'audit' },
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
