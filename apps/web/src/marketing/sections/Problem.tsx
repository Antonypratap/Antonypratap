import { Container, Icon, useInView, useSequence } from '../../design-system';
import styles from './Problem.module.css';

/**
 * The pain, concretely: a week of supplier bills at a brewpub or restaurant. Veyrafy goes down the
 * pile one bill at a time; most check out, and the ones that would have been overpaid are flagged
 * with what is wrong. Every row is always present and keeps its size; only colour and opacity
 * change, so nothing on the page moves. Illustrative suppliers and amounts.
 */
interface Bill {
  supplier: string;
  item: string;
  amount: string;
  /** What is wrong with it, or nothing. */
  problem?: string;
}

const WEEK: readonly Bill[] = [
  { supplier: 'Fresh Fields Produce', item: 'Vegetables and herbs', amount: '₹18,420' },
  {
    supplier: 'Coastal Catch Seafoods',
    item: 'Prawns · 20 kg billed',
    amount: '₹14,000',
    problem: 'Only 18 kg delivered',
  },
  { supplier: 'Malabar Malt House', item: 'Pale ale malt · 500 kg', amount: '₹32,550' },
  {
    supplier: 'Himalayan Hop Traders',
    item: 'Cascade hops · 10 kg',
    amount: '₹15,960',
    problem: '₹70/kg over agreed rate',
  },
  { supplier: 'Deccan Dairy', item: 'Milk and cream', amount: '₹6,880' },
  {
    supplier: 'Fresh Fields Produce',
    item: 'Vegetables and herbs',
    amount: '₹18,420',
    problem: 'Same bill as Monday’s',
  },
  { supplier: 'Southern Gas Co.', item: 'CO₂ cylinders', amount: '₹9,440' },
];

const LEAKS = [
  { title: 'Short deliveries, billed in full', example: '20 kg of prawns billed, 18 kg arrived.' },
  { title: 'Rates above what you agreed', example: 'Hops at ₹1,520/kg against ₹1,450 agreed.' },
  { title: 'The same bill, twice', example: 'Once on WhatsApp, again by email.' },
  {
    title: 'GST mistakes that cost you credit',
    example: 'A wrong GSTIN, and the input credit is gone.',
  },
];

const WRONG = WEEK.filter((b) => b.problem).length;

export function Problem() {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.35 });
  // One step per bill checked, then the summary; held, then played again.
  const step = useSequence(WEEK.length + 1, 900, inView, 600, 6000);
  const done = step > WEEK.length;

  return (
    <section className={styles.section} aria-labelledby="problem-title">
      <Container>
        <div className={styles.grid}>
          <div className={styles.copy}>
            <p className={styles.eyebrow}>The problem</p>
            <h2 id="problem-title" className={styles.title}>
              Supplier bills pile up. The mistakes hide inside them.
            </h2>
            <p className={styles.intro}>
              Malt and hops, meat and vegetables, dairy, CO₂, kegs and glassware: every delivery
              brings a bill. Each one should be checked against what was ordered and what actually
              came through the back door. In a busy week nobody has the time, so these get paid:
            </p>
            <ul className={styles.leaks}>
              {LEAKS.map((l) => (
                <li key={l.title}>
                  <span className={styles.leakDot} aria-hidden="true" />
                  <span>
                    <span className={styles.leakTitle}>{l.title}.</span>{' '}
                    <span className={styles.leakExample}>{l.example}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div ref={ref} className={styles.pile} aria-hidden="true">
            <div className={styles.pileHead}>
              <span>This week&rsquo;s bills</span>
              <span className={styles.pileCount}>{WEEK.length}</span>
            </div>
            <ul className={styles.bills}>
              {WEEK.map((b, i) => {
                const state =
                  i < step ? (b.problem ? 'wrong' : 'ok') : i === step ? 'checking' : 'waiting';
                return (
                  <li key={i} className={styles.bill} data-state={state}>
                    <span className={styles.who}>
                      <span className={styles.supplier}>{b.supplier}</span>
                      <span className={styles.item}>{b.item}</span>
                    </span>
                    <span className={styles.amount}>{b.amount}</span>
                    <span className={styles.verdict}>
                      <span className={styles.verdictWaiting}>Not checked</span>
                      <span className={styles.verdictOk}>
                        <Icon name="check" size={13} strokeWidth={2.6} /> Matches
                      </span>
                      <span className={styles.verdictWrong}>{b.problem}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className={styles.summary} data-on={done}>
              <span>
                <strong>
                  {WRONG} of {WEEK.length} bills were wrong.
                </strong>{' '}
                ₹20,520 caught before payment.
              </span>
            </div>
          </div>
        </div>
        <p className={styles.caption}>Illustrative example with sample data.</p>
      </Container>
    </section>
  );
}
