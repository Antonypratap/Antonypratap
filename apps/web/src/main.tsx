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

// Only the public website is for search engines: a client or demo instance keeps a plain tab title
// and tells crawlers not to index it (its server also sends X-Robots-Tag: noindex).
const host = classifyHost(window.location.hostname);
if (host.kind !== 'website') {
  document.title = 'Veyrafy';
  const robots = document.createElement('meta');
  robots.name = 'robots';
  robots.content = 'noindex, nofollow';
  document.querySelector('meta[name="robots"]')?.replaceWith(robots);
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <Surface host={host} />
    <Toaster />
  </StrictMode>,
);
