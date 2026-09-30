import { useEffect, useState } from 'react';
import { DEMO_ENTRY_HREF } from '../access/demoAccess';
import { ButtonLink, Container, Icon, Logo } from '../design-system';
import styles from './SiteNav.module.css';

const LINKS = [
  { href: '#product', label: 'Product' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#finance-teams', label: 'For finance teams' },
];

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
          <ButtonLink href={DEMO_ENTRY_HREF} size="sm">
            See Veyrafy in action
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
              {LINKS.map((l) => (
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
            href={DEMO_ENTRY_HREF}
            size="lg"
            arrow
            className={styles.sheetCta}
            onClick={() => setOpen(false)}
          >
            See Veyrafy in action
          </ButtonLink>
        </Container>
      </div>
    </header>
  );
}
