import { Container, SectionHeading } from '../../design-system';
import { FAQ } from '../seo';
import styles from './Faq.module.css';

/** Questions finance teams ask (the same text search engines receive as FAQ data; see seo.ts). */
export function Faq() {
  return (
    <section id="faq" className={styles.section} aria-labelledby="faq-title">
      <Container>
        <SectionHeading
          id="faq-title"
          eyebrow="Questions"
          title="What finance teams ask us."
          lede="Accounts payable automation, GST checks and three-way matching, in plain words."
        />
        <div className={styles.list}>
          {FAQ.map((f, i) => (
            <details key={f.q} className={styles.item} open={i === 0}>
              <summary className={styles.q}>{f.q}</summary>
              <p className={styles.a}>{f.a}</p>
            </details>
          ))}
        </div>
      </Container>
    </section>
  );
}
