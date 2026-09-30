import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Logo } from '../design-system';
import styles from '../access/SignIn.module.css';
import site from './SitePages.module.css';
import {
  CONTACT_PHONE,
  CONTACT_PHONE_HREF,
  DOMAIN,
  WEBSITE_ADDRESS,
  clientAddress,
  clientSlugFrom,
} from './host';

/**
 * The website's access pages (veyrafy.com): Client login (to the company's own Veyrafy address)
 * and Request access. They use the sign-in page's layout; no client list is published anywhere.
 */
function Frame({ children, home = '#top' }: { children: ReactNode; home?: string }) {
  return (
    <main className={styles.page}>
      <a href={home} className={styles.home} aria-label="Veyrafy home">
        <Logo />
      </a>
      {children}
      <a href={home} className={styles.back}>
        Back to the homepage
      </a>
    </main>
  );
}

export function ClientLogin({
  go = (url: string) => window.location.assign(url),
}: {
  /** Where Continue goes (tests replace the navigation). */
  go?: (url: string) => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const slug = clientSlugFrom(value);
    if (!slug) {
      setError('Enter your company’s Veyrafy address, for example “yourcompany”.');
      return;
    }
    go(clientAddress(slug));
  };
  return (
    <Frame>
      <form className={styles.panel} onSubmit={submit} aria-labelledby={`${id}-title`} noValidate>
        <h1 id={`${id}-title`} className={styles.title}>
          Client login
        </h1>
        <p className={styles.text}>Each company signs in at its own Veyrafy address.</p>
        <label className={styles.label} htmlFor={`${id}-address`}>
          Your company’s Veyrafy address
        </label>
        <div className={site.address}>
          <input
            id={`${id}-address`}
            className={styles.input}
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            aria-invalid={error !== null}
            aria-describedby={`${id}-suffix ${error ? `${id}-error` : ''}`.trim()}
            autoFocus
          />
          <span id={`${id}-suffix`} className={site.suffix}>
            .{DOMAIN}
          </span>
        </div>
        <p id={`${id}-error`} className={styles.error} role="alert">
          {error ?? ''}
        </p>
        <Button type="submit" size="lg" arrow className={styles.submit}>
          Continue
        </Button>
        <p className={site.aside}>
          No Veyrafy address yet? <a href="#/request-access">Request access</a>
        </p>
      </form>
    </Frame>
  );
}

export function RequestAccess() {
  const id = useId();
  return (
    <Frame>
      <section className={styles.panel} aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} className={styles.title}>
          Request access
        </h1>
        <p className={site.body}>
          Veyrafy is invite-only while we onboard our first clients. To get started, call{' '}
          <a href={CONTACT_PHONE_HREF}>{CONTACT_PHONE}</a>.
        </p>
      </section>
    </Frame>
  );
}

/** A client address with no Veyrafy instance behind it, or one that cannot answer right now. */
export function AddressNotSetUp({ unavailable = false }: { unavailable?: boolean }) {
  const id = useId();
  return (
    <Frame home={WEBSITE_ADDRESS}>
      <section className={styles.panel} aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} className={styles.title}>
          {unavailable
            ? 'Veyrafy is not available right now'
            : 'This Veyrafy address isn’t set up.'}
        </h1>
        <p className={site.body}>
          {unavailable ? (
            'Try again in a few minutes.'
          ) : (
            <>
              Check the address with your administrator, or go to{' '}
              <a href={`${WEBSITE_ADDRESS}#/login`}>Client login</a>.
            </>
          )}
        </p>
      </section>
    </Frame>
  );
}

/** Website pages by address: `#/login`, `#/request-access`; anything else is not one. */
export function sitePageOf(hash: string): 'login' | 'request-access' | null {
  const path = hash
    .replace(/^#/, '')
    .replace(/[?].*$/, '')
    .replace(/\/+$/, '');
  if (path === '/login') return 'login';
  if (path === '/request-access') return 'request-access';
  return null;
}
