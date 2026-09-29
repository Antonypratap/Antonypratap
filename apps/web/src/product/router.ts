import { useSyncExternalStore } from 'react';

/**
 * Hash routes keep the whole product previewable as one static page:
 *   #/app            inbox
 *   #/app/questions
 *   #/app/invoices[?filter]
 *   #/app/invoices/<id>
 *   #/app/erp/<tab>        (tab `data`: import and export business records)
 *   #/app/audit[/<id>]
 * Anything else (including the homepage's #section anchors) is the marketing site.
 */
export const ERP_TABS = [
  'vendors',
  'items',
  'orders',
  'receipts',
  'invoices',
  'data',
  'connection',
] as const;
export type ErpTab = (typeof ERP_TABS)[number];
export const INVOICE_FILTERS = ['all', 'attention', 'handled'] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];

export type Route =
  | { name: 'home' }
  | { name: 'inbox' }
  | { name: 'questions' }
  | { name: 'invoices'; filter: InvoiceFilter }
  | { name: 'invoice'; id: string }
  | { name: 'erp'; tab: ErpTab }
  | { name: 'audit'; id: string | null };

const isOneOf = <T extends string>(list: readonly T[], v: string | undefined): v is T =>
  list.includes(v as T);

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith('/app')) return { name: 'home' };
  const [path = '', query = ''] = h.slice('/app'.length).split('?');
  const [section, arg] = path.split('/').filter(Boolean);
  switch (section) {
    case undefined:
    case 'inbox':
      return { name: 'inbox' };
    case 'questions':
      return { name: 'questions' };
    case 'invoices':
      if (arg) return { name: 'invoice', id: arg };
      return { name: 'invoices', filter: isOneOf(INVOICE_FILTERS, query) ? query : 'all' };
    case 'erp':
      return { name: 'erp', tab: isOneOf(ERP_TABS, arg) ? arg : 'vendors' };
    case 'audit':
      return { name: 'audit', id: arg ?? null };
    default:
      return { name: 'inbox' };
  }
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#';
    case 'inbox':
      return '#/app/inbox';
    case 'questions':
      return '#/app/questions';
    case 'invoices':
      return route.filter === 'all' ? '#/app/invoices' : `#/app/invoices?${route.filter}`;
    case 'invoice':
      return `#/app/invoices/${route.id}`;
    case 'erp':
      return `#/app/erp/${route.tab}`;
    case 'audit':
      return route.id ? `#/app/audit/${route.id}` : '#/app/audit';
  }
}

/**
 * A product address typed or shared as a path (`/app/inbox`, `/app/invoices/<id>`): the hash
 * route it means, or null. The host serves index.html for every path (vercel.json, Caddy
 * `try_files`), and the app then shows the same screen as `/#/app/inbox`.
 */
export function hashForPath(pathname: string, search: string): string | null {
  if (pathname !== '/app' && !pathname.startsWith('/app/')) return null;
  return `#${pathname.replace(/\/+$/, '')}${search}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useHash(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => '',
  );
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route);
}
