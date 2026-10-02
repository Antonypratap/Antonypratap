import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Permission } from '@veyra/shared';
import { signOut, useSession } from '../../access/session';
import { Icon, Logo, type IconName } from '../../design-system';
import { WEBSITE_ADDRESS, classifyHost } from '../../site/host';
import { hrefFor, type Route } from '../router';
import { api } from '../api/client';
import { useProductData } from '../state/data';
import { ROLE_TEXT } from '../state/roles';
import styles from './AppShell.module.css';
import { DemoProvider, DemoTrigger } from './DemoPanel';
import { UploadsProvider, useUploads } from '../upload/Uploads';

type Section = 'inbox' | 'questions' | 'invoices' | 'erp' | 'audit' | 'settings';

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
    case 'settings':
      return 'settings';
    default:
      return 'inbox';
  }
}

/** Upload from any screen (files can also be dropped or pasted anywhere). */
function TopbarUpload() {
  const uploads = useUploads();
  if (!uploads.enabled) return null;
  return (
    <button
      type="button"
      className={styles.uploadButton}
      onClick={uploads.chooseFiles}
      disabled={uploads.busy}
    >
      <Icon name="upload" size={16} />
      <span className={styles.uploadLabel}>{uploads.busy ? 'Uploading…' : 'Upload'}</span>
    </button>
  );
}

/** The signed-in person: who they are, their role, settings and sign-out. */
function AccountMenu({
  name,
  email,
  role,
  organization,
  initials,
}: {
  name: string;
  email: string;
  role: string;
  organization: string;
  initials: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className={styles.account} ref={box}>
      <button
        type="button"
        className={styles.user}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        onClick={() => setOpen((v) => !v)}
      >
        {initials}
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.menuWho}>
            <span className={styles.menuName}>{name}</span>
            <span className={styles.menuSub}>{email}</span>
            <span className={styles.menuSub}>
              {ROLE_TEXT[role]?.label ?? role} · {organization}
            </span>
          </div>
          <a
            role="menuitem"
            className={styles.menuItem}
            href={hrefFor({ name: 'settings', tab: 'account' })}
            onClick={() => setOpen(false)}
          >
            Settings
          </a>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** The website, from a client address; the local homepage in development. */
function websiteHref(): string {
  return classifyHost(window.location.hostname).kind === 'development' ? '#top' : WEBSITE_ADDRESS;
}

export function AppShell({ route, children }: { route: Route; children: ReactNode }) {
  const { inbox, refresh } = useProductData();
  const hasData = (inbox?.counts.received ?? 0) > 0;
  const waiting = inbox?.counts.needsYou ?? 0;
  const active = route.name === 'invoice' ? null : sectionOf(route);
  // Wide screens only (narrower ones show the icon rail or the tab bar); not remembered.
  const [collapsed, setCollapsed] = useState(false);
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
      <UploadsProvider enabled={may('documents.upload')}>
        <div className={styles.shell} data-collapsed={collapsed}>
          <aside className={styles.sidebar}>
            <a
              href={hrefFor({ name: 'inbox' })}
              className={styles.brand}
              aria-label="Veyrafy inbox"
            >
              <Logo tone="inverse" />
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
            <button
              type="button"
              className={styles.collapse}
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'Show the full menu' : 'Collapse the menu'}
              title={collapsed ? 'Show the full menu' : 'Collapse the menu'}
            >
              <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
              <span className={styles.navLabel}>Collapse</span>
            </button>
            <div className={styles.sidebarFoot}>
              {me && (
                <a
                  className={styles.me}
                  href={hrefFor({ name: 'settings', tab: 'account' })}
                  aria-current={route.name === 'settings' ? 'page' : undefined}
                >
                  <span className={styles.meName}>{me.user.name}</span>
                  <span className={styles.meSub}>
                    {ROLE_TEXT[me.user.role]?.label ?? me.user.role} · {me.organization.name}
                  </span>
                </a>
              )}
              <a className={styles.siteLink} href={hrefFor({ name: 'settings', tab: 'account' })}>
                Settings
              </a>
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
              <a href={websiteHref()} className={styles.siteLink}>
                veyrafy.com
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
              <TopbarUpload />
              {me && (
                <AccountMenu
                  name={me.user.name}
                  email={me.user.email}
                  role={me.user.role}
                  organization={me.organization.name}
                  initials={initials}
                />
              )}
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
      </UploadsProvider>
    </DemoProvider>
  );
}
