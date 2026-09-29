import './csp';
import { StrictMode, Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './design-system/base.css';
import { loadSession, useSession } from './access/session';
import { HomePage } from './marketing/HomePage';
import { parseHash, useHash } from './product/router';
import { Toaster } from './feedback/Toaster';

// The workspace and sign-in load on demand: the public homepage does not download them.
const ProductApp = lazy(() =>
  import('./product/ProductApp').then((m) => ({ default: m.ProductApp })),
);
const SignIn = lazy(() => import('./access/SignIn').then((m) => ({ default: m.SignIn })));

function Root() {
  const route = parseHash(useHash());
  const inProduct = route.name !== 'home';
  const screenKey = route.name === 'invoice' ? `invoice/${route.id}` : route.name;
  // Product routes need a signed-in session; the server decides (the homepage stays public).
  const session = useSession();
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
        <SignIn demo={session.demoSignIn} notice={session.notice} />
      ) : (
        <ProductApp route={route} />
      )}
    </Suspense>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <Root />
    <Toaster />
  </StrictMode>,
);
