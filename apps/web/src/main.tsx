import './csp';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design-system/base.css';
import { hashForPath } from './product/router';
import { Toaster } from './feedback/Toaster';
import { classifyHost } from './site/host';
import { Surface } from './site/Surface';

// /app/… as a path (a shared link, a refresh) is the same screen as /#/app/…; no reload.
const pathRoute = hashForPath(window.location.pathname, window.location.search);
if (pathRoute) window.history.replaceState(null, '', `/${pathRoute}`);

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <Surface host={classifyHost(window.location.hostname)} />
    <Toaster />
  </StrictMode>,
);
