import './csp';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './design-system/base.css';
import { SignIn } from './access/SignIn';
import { loadSession, useSession } from './access/session';
import { HomePage } from './marketing/HomePage';
import { ProductApp } from './product/ProductApp';
import { parseHash, useHash } from './product/router';

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
  if (session.status === 'signedOut')
    return <SignIn demo={session.demoSignIn} notice={session.notice} />;
  return <ProductApp route={route} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
