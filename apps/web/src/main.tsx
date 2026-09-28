import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './design-system/base.css';
import { hasDemoAccess } from './access/demoAccess';
import { DemoGate } from './access/DemoGate';
import { HomePage } from './marketing/HomePage';
import { ProductApp } from './product/ProductApp';
import { parseHash, useHash } from './product/router';

function Root() {
  const route = parseHash(useHash());
  const inProduct = route.name !== 'home';
  const screenKey = route.name === 'invoice' ? `invoice/${route.id}` : route.name;
  // Demo gate (not authentication): product routes need the demo PIN once per browser session.
  const [granted, setGranted] = useState(hasDemoAccess);
  // Each product screen starts at the top; the homepage keeps its own anchor scrolling.
  useEffect(() => {
    if (inProduct) window.scrollTo(0, 0);
  }, [inProduct, screenKey]);
  if (!inProduct) return <HomePage />;
  if (!granted) return <DemoGate onGranted={() => setGranted(true)} />;
  return <ProductApp route={route} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
