import type { ReactNode } from 'react';
import type { Permission } from '@veyra/shared';
import { signOut, useSession } from '../../access/session';
import { Icon, Logo, type IconName } from '../../design-system';
import { hrefFor, type Route } from '../router';
import { api } from '../api/client';
import { useProductData } from '../state/data';
import styles from './AppShell.module.css';
import { DemoProvider, DemoTrigger } from './DemoPanel';

type Section = 'inbox' | 'questions' | 'invoices' | 'erp' | 'audit';

const NAV: {
  key: Section;
  label: string;
  icon: IconName;
  route: Route;
  /** Hidden for roles without it (the server refuses them anyway). */
  needs?: Permission;
}[] = [
  { key: 'inbox', label: 'Inbox', icon: 'inbox', route: { name: 'inbox' } },
  { key: 'questions', label: 'Questions', icon: 'question', route: { name: 'questions' } },
  {
    key: 'invoices',
    label: 'Invoices',
    icon: 'document',
    route: { name: 'invoices', filter: 'all' },
  },
  {
    key: 'erp',
    label: 'ERP',
    icon: 'database',
    route: { name: 'erp', tab: 'vendors' },
    needs: 'erp.view',
  },
  {
    key: 'audit',
    label: 'Audit',
    icon: 'audit',
    route: { name: 'audit', id: null },
    needs: 'audit.view',
  },
];

export function sectionOf(route: Route): Section {
  switch (route.name) {
    case 'questions':
      return 'questions';
    case 'invoices':
    case 'invoice':
      return 'invoices';
    case 'erp':
      return 'erp';
    case 'audit':
      return 'audit';
    default:
      return 'inbox';
  }
}

export function AppShell({ route, children }: { route: Route; children: ReactNode }) {
  const { inbox, refresh } = useProductData();
  const hasData = (inbox?.counts.received ?? 0) > 0;
  const waiting = inbox?.counts.needsYou ?? 0;
  const active = route.name === 'invoice' ? null : sectionOf(route);
  const session = useSession();
  const me = session.status === 'signedIn' ? session.session : null;
  const may = (p: Permission) => me?.permissions.includes(p) ?? false;
  const nav = NAV.filter((item) => !item.needs || may(item.needs));
  const initials = (me?.user.name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <DemoProvider>
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <a href={hrefFor({ name: 'inbox' })} className={styles.brand} aria-label="Veyrafy inbox">
            <Logo />
          </a>
          <nav aria-label="Product">
            <ul className={styles.nav}>
              {nav.map((item) => (
                <li key={item.key}>
                  <a
                    href={hrefFor(item.route)}
                    className={styles.navItem}
                    aria-current={(active ?? sectionOf(route)) === item.key ? 'page' : undefined}
                  >
                    <Icon name={item.icon} size={18} />
                    <span className={styles.navLabel}>{item.label}</span>
                    {(item.key === 'inbox' || item.key === 'questions') && waiting > 0 && (
                      <span className={styles.count} aria-label={`${waiting} waiting`}>
                        {waiting}
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className={styles.sidebarFoot}>
            {me?.demoSignIn && (
              <p className={styles.demoNote}>Demo workspace. Sample ERP; no payments are made.</p>
            )}
            {hasData && may('demo.manage') && (
              <button
                type="button"
                className={styles.siteLink}
                onClick={() => {
                  if (
                    window.confirm(
                      'Reset the demo? This clears every invoice and restores the sample ERP.',
                    )
                  )
                    void api.resetDemo().then(() => refresh());
                }}
              >
                Reset demo
              </button>
            )}
            <button type="button" className={styles.siteLink} onClick={() => void signOut()}>
              Sign out
            </button>
            <a href="#top" className={styles.siteLink}>
              veyra.com
            </a>
          </div>
        </aside>

        <div className={styles.main}>
          <header className={styles.topbar}>
            <a
              href={hrefFor({ name: 'inbox' })}
              className={styles.mobileBrand}
              aria-label="Veyrafy inbox"
            >
              <Logo />
            </a>
            <label className={styles.search}>
              <Icon name="search" size={16} />
              <span className="visually-hidden">Search</span>
              <input
                type="search"
                placeholder="Search invoices and suppliers"
                disabled
                title="Search arrives in a later version"
              />
            </label>
            {may('demo.manage') && <DemoTrigger className={styles.demoButton} />}
            <span
              className={styles.user}
              title={me ? `${me.user.name} (${me.user.role.toLowerCase()})` : undefined}
            >
              {initials}
            </span>
          </header>
          <main
            className={styles.content}
            key={route.name === 'invoice' ? `invoice-${route.id}` : route.name}
          >
            {children}
          </main>
        </div>

        <nav className={styles.tabbar} aria-label="Product (mobile)">
          {nav.map((item) => (
            <a
              key={item.key}
              href={hrefFor(item.route)}
              className={styles.tab}
              aria-current={sectionOf(route) === item.key ? 'page' : undefined}
            >
              <span className={styles.tabIcon}>
                <Icon name={item.icon} size={20} />
                {item.key === 'inbox' && waiting > 0 && <span className={styles.tabDot} />}
              </span>
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    </DemoProvider>
  );
}
