import { Container, Reveal } from '../../design-system';
import styles from './WhyNow.module.css';

/** Icons drawn for this section only (24px grid, stroke). */
const ICONS = {
  credit: 'M4 4h16v16H4zM8 9h8M8 13h5M15 15l4 4M19 15l-4 4',
  clock: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2.5 2.5M9 2h6',
  copy: 'M10 8h10v12H10zM16 8V4H4v12h4',
};

const RISKS: { icon: keyof typeof ICONS; title: string; body: string; answer: string }[] = [
  {
    icon: 'credit',
    title: 'Tax credit you can’t claim',
    body: 'Input tax credit can be claimed only when the supplier’s invoice appears in your GSTR-2B. A wrong GSTIN or tax line found at filing time is found too late.',
    answer: 'checks every GSTIN and tax line the day the invoice arrives.',
  },
  {
    icon: 'clock',
    title: 'MSME payments that run late',
    body: 'Pay a registered micro or small supplier after the agreed date (45 days at most) and, under Section 43B(h), the expense is deductible only in the year you actually pay.',
    answer: 'clears the checking in minutes, so approvals stop eating into the clock.',
  },
  {
    icon: 'copy',
    title: 'Paying twice, or paying for more',
    body: 'The same invoice sent twice. More billed than arrived. A rate higher than the order. They get paid when nobody has time to compare.',
    answer: 'compares every invoice with the order and the goods receipt, and stops duplicates.',
  },
];

export function WhyNow() {
  return (
    <section id="why-now" className={styles.section} aria-labelledby="why-now-title">
      <Container className={styles.inner}>
        <div className={styles.head}>
          <div className={styles.titleBlock}>
            <p className={styles.eyebrow}>Why it can’t wait</p>
            <h2 id="why-now-title" className={styles.title}>
              What slips through manual checking costs real money.
            </h2>
          </div>
          <p className={styles.lede}>
            Every month, the same three things get past a busy finance team. None of them is visible
            until it is too late to fix cheaply.
          </p>
        </div>
        <div className={styles.grid}>
          {RISKS.map((r, i) => (
            <Reveal key={r.title} as="article" delay={i * 80} className={styles.card}>
              <span className={styles.icon} aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  width="26"
                  height="26"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={ICONS[r.icon]} />
                </svg>
              </span>
              <h3 className={styles.cardTitle}>{r.title}</h3>
              <p className={styles.body}>{r.body}</p>
              <p className={styles.answer}>
                <strong>Veyrafy</strong> {r.answer}
              </p>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
