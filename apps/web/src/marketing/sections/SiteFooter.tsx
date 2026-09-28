import { Container, Logo } from '../../design-system';
import styles from './SiteFooter.module.css';

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <Container className={styles.inner}>
        <Logo />
        <p className={styles.tagline}>Invoices, handled.</p>
        <p className={styles.copyright}>© {new Date().getFullYear()} Veyra</p>
      </Container>
    </footer>
  );
}
