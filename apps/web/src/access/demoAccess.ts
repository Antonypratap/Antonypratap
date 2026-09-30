import { DEMO_ADDRESS, classifyHost } from '../site/host';

/**
 * Where "See Veyrafy in action" leads. On the website: the public demo instance
 * (demo.veyrafy.com, its own deployment and sample data, where the demo PIN is checked by the
 * server). In development: the local workspace, as before. Nothing about access is decided in the
 * browser.
 */
export function demoEntryHref(
  hostname: string = typeof window === 'undefined' ? '' : window.location.hostname,
): string {
  return classifyHost(hostname).kind === 'development' ? '#/app/inbox' : DEMO_ADDRESS;
}
