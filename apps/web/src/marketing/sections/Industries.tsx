import { Container } from '../../design-system';
import styles from './Industries.module.css';

/** Who it is for: businesses with recurring supplier invoices and goods received against them. */
const INDUSTRIES = [
  'Restaurants & F&B',
  'Hotels & hospitality',
  'Retail & supermarkets',
  'Manufacturing',
  'Warehouses & distribution',
  'Co-working & commercial facilities',
  'Healthcare & institutions',
];

export function Industries() {
  return (
    <section id="who-its-for" className={styles.section} aria-labelledby="industries-title">
      <Container className={styles.inner}>
        <div>
          <p className={styles.eyebrow}>Who it’s for</p>
          <h2 id="industries-title" className={styles.title}>
            Built for businesses that buy, receive and pay.
          </h2>
          <p className={styles.lede}>
            Wherever goods arrive against an order and a supplier sends a bill for them.
          </p>
        </div>
        <ul className={styles.list}>
          {INDUSTRIES.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
