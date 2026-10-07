import { Container, Icon, Reveal } from '../../design-system';
import styles from './RealProblem.module.css';

/**
 * The problem in one look: three records of the same purchase, kept by different people, that do
 * not always agree. One illustrative line (sample figures) shows a quantity and a rate that differ.
 */
const SOURCES: {
  name: string;
  meaning: string;
  owner: string;
  rows: { label: string; value: string; differs?: boolean }[];
}[] = [
  {
    name: 'Purchase order',
    meaning: 'What you agreed to buy',
    owner: 'Purchasing',
    rows: [
      { label: 'Quantity', value: '1,000 kg' },
      { label: 'Rate', value: '₹120 / kg' },
    ],
  },
  {
    name: 'GRN / goods received',
    meaning: 'What actually arrived',
    owner: 'Store / facility',
    rows: [
      { label: 'Quantity', value: '960 kg' },
      { label: 'Recorded', value: 'At the receiving dock' },
    ],
  },
  {
    name: 'Supplier invoice',
    meaning: 'What you’re being asked to pay',
    owner: 'Supplier → finance',
    rows: [
      { label: 'Quantity', value: '1,000 kg', differs: true },
      { label: 'Rate', value: '₹128 / kg', differs: true },
    ],
  },
];

export function RealProblem() {
  return (
    <section id="the-problem" className={styles.section} aria-labelledby="real-problem-title">
      <Container>
        <div className={styles.head}>
          <p className={styles.eyebrow}>The real problem</p>
          <h2 id="real-problem-title" className={styles.title}>
            Your store team knows what arrived.{' '}
            <span className={styles.muted}>Your finance team knows what was billed.</span>
          </h2>
          <p className={styles.lede}>Those two records don’t always match.</p>
        </div>

        <ol className={styles.sources}>
          {SOURCES.map((s, i) => (
            <Reveal as="li" key={s.name} delay={i * 100} className={styles.source}>
              <p className={styles.owner}>{s.owner}</p>
              <h3 className={styles.name}>{s.name}</h3>
              <p className={styles.meaning}>{s.meaning}</p>
              <dl className={styles.rows}>
                {s.rows.map((r) => (
                  <div key={r.label} data-differs={r.differs ?? false}>
                    <dt>{r.label}</dt>
                    <dd>
                      {r.value}
                      {r.differs && (
                        <>
                          {' '}
                          <Icon name="attention" size={13} />
                          <span className="visually-hidden"> (differs)</span>
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </Reveal>
          ))}
        </ol>

        <div className={styles.together}>
          <p className={styles.togetherTitle}>
            <span className={styles.mark} aria-hidden="true" />
            Veyrafy brings them together before payment.
          </p>
          <p className={styles.togetherText}>
            Works with the records your finance team already maintains: your accounting or ERP
            system, or an Excel, CSV or JSON export of it.
          </p>
        </div>
        <p className={styles.caption}>Illustrative example with sample figures.</p>
      </Container>
    </section>
  );
}
