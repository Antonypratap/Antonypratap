import { Container, Logo } from '../../design-system';
import { CONTACT_PHONE, CONTACT_PHONE_HREF } from '../../site/host';
import styles from './SiteFooter.module.css';

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <Container className={styles.inner}>
        <Logo />
        <p className={styles.tagline}>Invoices, handled.</p>
        <nav className={styles.links} aria-label="Access">
          <a href="#/login">Client login</a>
          <a href="#/request-access">Request access</a>
          <a href={CONTACT_PHONE_HREF}>{CONTACT_PHONE}</a>
        </nav>
        <p className={styles.copyright}>© {new Date().getFullYear()} Veyrafy</p>
      </Container>
    </footer>
  );
}
