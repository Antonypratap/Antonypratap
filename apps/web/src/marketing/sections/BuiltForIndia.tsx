import { Container, Icon, Reveal } from '../../design-system';
import { demoEntryHref } from '../../access/demoAccess';
import styles from './BuiltForIndia.module.css';

const CHECKS = [
  { title: 'GSTIN checked', body: 'Format, checksum and state code, for you and every supplier.' },
  {
    title: 'CGST, SGST or IGST',
    body: 'The right taxes for intra- or inter-state supply, rate by rate.',
  },
  { title: 'HSN codes and units', body: 'Matched to your item master, never assumed.' },
  { title: 'Exact to the paisa', body: 'Lines, taxes and round-off add up, or Veyrafy asks.' },
  {
    title: 'No double payments',
    body: 'Duplicates caught by supplier, invoice number and financial year.',
  },
  { title: 'PDFs, scans and photos', body: 'Invoices arrive the way suppliers already send them.' },
  {
    title: 'Your ERP, or Excel',
    body: 'Reads your orders and receipts; records the verified invoice.',
  },
  { title: 'A full audit trail', body: 'What Veyrafy checked, what it asked, and who decided.' },
];

export function BuiltForIndia() {
  return (
    <section id="built-for-india" className={styles.section} aria-labelledby="india-title">
      <Container className={styles.inner}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Built for India</p>
          <h2 id="india-title" className={styles.title}>
            It knows GST as well as your team does.
          </h2>
          <p className={styles.lede}>
            Veyrafy is made for Indian invoices: the tax rules, the codes and the way suppliers
            actually send them. Every check is exact, to the paisa.
          </p>
          <a href={demoEntryHref()} className={styles.link}>
            Try it on a sample invoice
            <Icon name="arrowRight" size={16} />
          </a>
        </div>
        <ul className={styles.grid}>
          {CHECKS.map((c, i) => (
            <Reveal key={c.title} as="li" delay={(i % 4) * 60} className={styles.tile}>
              <span className={styles.tick} aria-hidden="true">
                <Icon name="check" size={18} strokeWidth={2.4} />
              </span>
              <h3 className={styles.tileTitle}>{c.title}</h3>
              <p className={styles.tileBody}>{c.body}</p>
            </Reveal>
          ))}
        </ul>
      </Container>
    </section>
  );
}
