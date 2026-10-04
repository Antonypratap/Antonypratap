import { Suspense, lazy, useEffect, useState } from 'react';
import { loadSession, signOut, useAccountSuspended, useSession } from '../access/session';
import { Logo } from '../design-system';
import { HomePage } from '../marketing/HomePage';
import { parseHash, useHash } from '../product/router';
import { WEBSITE_ADDRESS, type HostKind } from './host';
import { checkInstance, type InstanceCheck } from './instance';
import { AddressNotSetUp, ClientLogin, RequestAccess, sitePageOf } from './SitePages';
import site from './SitePages.module.css';

// The workspace and sign-in load on demand: the public homepage does not download them.
const ProductApp = lazy(() =>
  import('../product/ProductApp').then((m) => ({ default: m.ProductApp })),
);
const SignIn = lazy(() => import('../access/SignIn').then((m) => ({ default: m.SignIn })));
// Veyrafy Operations (Phase 8A): a separate surface, loaded only when opened.
const OpsApp = lazy(() => import('../ops/OpsApp').then((m) => ({ default: m.OpsApp })));
const OperatorNotice = lazy(() =>
  import('../ops/OperatorNotice').then((m) => ({ default: m.OperatorNotice })),
);

/**
 * The product: sign-in, then the workspace. On a client instance there is no homepage, so the
 * bare address opens the workspace (after sign-in); the organization's name is shown on sign-in.
 */
function Root({ instance }: { instance: { name: string } | null }) {
  const parsed = parseHash(useHash());
  const route = instance && parsed.name === 'home' ? ({ name: 'inbox' } as const) : parsed;
  const inProduct = route.name !== 'home';
  const screenKey = route.name === 'invoice' ? `invoice/${route.id}` : route.name;
  // Product routes need a signed-in session; the server decides (the homepage stays public).
  const session = useSession();
  const suspended = useAccountSuspended();
  useEffect(() => {
    if (inProduct && session.status === 'loading') void loadSession();
  }, [inProduct, session.status]);
  // Each product screen starts at the top; the homepage keeps its own anchor scrolling.
  useEffect(() => {
    if (inProduct) window.scrollTo(0, 0);
  }, [inProduct, screenKey]);
  if (!inProduct) return <HomePage />;
  if (session.status === 'loading') return null;
  return (
    <Suspense fallback={null}>
      {session.status === 'signedOut' ? (
        <SignIn
          demo={session.demoSignIn}
          notice={session.notice}
          organization={instance?.name ?? null}
          home={instance ? WEBSITE_ADDRESS : '#top'}
        />
      ) : route.name === 'ops' ? (
        <OpsApp route={route} />
      ) : session.session.user.role === 'VEYRA_ADMIN' ? (
        // A Veyrafy operator has no customer permissions: point to Veyrafy Operations instead.
        <OperatorNotice />
      ) : suspended ? (
        <Suspended />
      ) : (
        <ProductApp route={route} />
      )}
    </Suspense>
  );
}

/** The customer's account is suspended by Veyrafy (the server refuses every request). */
function Suspended() {
  return (
    <main className={site.suspended} role="alert">
      <Logo />
      <h1>This Veyrafy account is suspended</h1>
      <p>Your invoices and records are kept safely. Contact Veyrafy to restore access.</p>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </main>
  );
}

/** A client address: confirmed by its own instance before anything else is shown. */
function ClientInstance() {
  const [check, setCheck] = useState<InstanceCheck | null>(null);
  useEffect(() => {
    void checkInstance().then(setCheck);
  }, []);
  if (!check) return null;
  if (check.status !== 'ready')
    return <AddressNotSetUp unavailable={check.status === 'unavailable'} />;
  return <Root instance={check.instance} />;
}

/**
 * What this address shows (site/host.ts). The website never shows the application or a sign-in
 * form; a client address never shows the marketing site; development shows everything.
 */
export function Surface({ host, hash: forced }: { host: HostKind; hash?: string }) {
  const live = useHash();
  const hash = forced ?? live;
  if (host.kind === 'unknown') return <AddressNotSetUp />;
  if (host.kind === 'client') return <ClientInstance />;
  const page = sitePageOf(hash);
  if (page === 'login') return <ClientLogin />;
  if (page === 'request-access') return <RequestAccess />;
  if (host.kind === 'website')
    // An old or mistyped application link on the website: the way in is Client login.
    return parseHash(hash).name === 'home' ? <HomePage /> : <ClientLogin />;
  return <Root instance={null} />;
}
