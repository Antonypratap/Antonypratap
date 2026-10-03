import { Container, Logo } from '../../design-system';
import { demoEntryHref } from '../../access/demoAccess';
import { CONTACT_PHONE, CONTACT_PHONE_HREF } from '../../site/host';
import styles from './SiteFooter.module.css';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '#why-now', label: 'Why now' },
      { href: '#how-it-works', label: 'How it works' },
      { href: '#built-for-india', label: 'Built for India' },
      { href: '#whats-next', label: 'What’s next' },
      { href: '#faq', label: 'Questions' },
    ],
  },
  {
    title: 'Access',
    links: [
      { href: '#/login', label: 'Client login' },
      { href: '#/request-access', label: 'Request access' },
      { href: CONTACT_PHONE_HREF, label: 'Book a walkthrough' },
    ],
  },
];

const PRINCIPLES = ['Never pays anything', 'Never guesses', 'Every step on record'];

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <Container className={styles.inner}>
        <div className={styles.columns}>
          <div className={styles.brand}>
            <a href="#top" aria-label="Veyrafy home" className={styles.logo}>
              <Logo tone="inverse" />
            </a>
            <p className={styles.tagline}>
              Invoice verification before payment, against your accounting records.
            </p>
            <a href={CONTACT_PHONE_HREF} className={styles.phone}>
              {CONTACT_PHONE}
            </a>
          </div>
          {COLUMNS.map((c) => (
            <nav key={c.title} aria-label={c.title} className={styles.column}>
              <p className={styles.heading}>{c.title}</p>
              <ul>
                {c.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.href}>{l.label}</a>
                  </li>
                ))}
                {c.title === 'Product' && (
                  <li>
                    <a href={demoEntryHref()}>See Veyrafy in action</a>
                  </li>
                )}
              </ul>
            </nav>
          ))}
          <div className={styles.column}>
            <p className={styles.heading}>Our principles</p>
            <ul>
              {PRINCIPLES.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className={styles.bottom}>
          <p>© {new Date().getFullYear()} Veyrafy. All rights reserved.</p>
          <p>Invoices, figures and names shown on this site are illustrative sample data.</p>
        </div>
      </Container>
    </footer>
  );
}
