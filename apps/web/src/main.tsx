import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './design-system/base.css';
import { HomePage } from './marketing/HomePage';
import { ProductApp } from './product/ProductApp';
import { parseHash, useHash } from './product/router';
import { DemoStoreProvider } from './product/state/DemoStore';

function Root() {
  const route = parseHash(useHash());
  const inProduct = route.name !== 'home';
  const screenKey = route.name === 'invoice' ? `invoice/${route.id}` : route.name;
  // Each product screen starts at the top; the homepage keeps its own anchor scrolling.
  useEffect(() => {
    if (inProduct) window.scrollTo(0, 0);
  }, [inProduct, screenKey]);
  return inProduct ? <ProductApp route={route} /> : <HomePage />;
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <DemoStoreProvider>
      <Root />
    </DemoStoreProvider>
  </StrictMode>,
);
