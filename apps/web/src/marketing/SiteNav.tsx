import { useEffect, useState } from 'react';
import { ButtonLink, Container, Icon, Logo } from '../design-system';
import styles from './SiteNav.module.css';

const LINKS = [
  { href: '#the-problem', label: 'The problem' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#who-its-for', label: 'Who it’s for' },
];
/** The website's way in for clients; prospects use the Book a Demo button. */
const ACCESS_LINKS = [{ href: '#/login', label: 'Client login' }];

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const mql = window.matchMedia('(min-width: 861px)');
    const onWide = (): void => {
      if (mql.matches) setOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    mql.addEventListener('change', onWide);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
      mql.removeEventListener('change', onWide);
    };
  }, [open]);

  return (
    <header className={styles.header} data-scrolled={scrolled || open} data-open={open}>
      <Container className={styles.bar}>
        <a href="#top" className={styles.brand} aria-label="Veyrafy home">
          <Logo />
        </a>
        <nav className={styles.links} aria-label="Primary">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className={styles.link}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className={styles.actions}>
          <ButtonLink href="#/login" size="sm" variant="secondary">
            Client login
          </ButtonLink>
          <ButtonLink href="#/request-access" size="sm">
            Book a Demo
          </ButtonLink>
        </div>
        <button
          type="button"
          className={styles.menuButton}
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={open ? 'close' : 'menu'} size={20} />
        </button>
      </Container>

      <div id="mobile-menu" className={styles.sheet} hidden={!open}>
        <Container>
          <nav aria-label="Mobile">
            <ul className={styles.sheetLinks}>
              {[...LINKS, ...ACCESS_LINKS].map((l) => (
                <li key={l.href}>
                  <a href={l.href} className={styles.sheetLink} onClick={() => setOpen(false)}>
                    {l.label}
                    <Icon name="arrowRight" size={18} />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <ButtonLink
            href="#/request-access"
            size="lg"
            arrow
            className={styles.sheetCta}
            onClick={() => setOpen(false)}
          >
            Book a Demo
          </ButtonLink>
        </Container>
      </div>
    </header>
  );
}
