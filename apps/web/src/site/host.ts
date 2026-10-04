/**
 * Which surface an address is (production setup, docs/RUNBOOK-RAILWAY.md):
 *
 * - the public website: veyrafy.com, www.veyrafy.com. Marketing, Client login, Request access;
 *   never the application or a sign-in form.
 * - development: localhost, 127.0.0.1. Everything, as before (website pages and the app).
 * - a client address: <slug>.veyrafy.com, one Veyrafy instance per client (its own deployment
 *   and database). Only that instance's own GET /api/v1/instance confirms it is set up; no list
 *   of clients exists in this code, so a new client never needs a website release. A platform
 *   address (e.g. the service's own *.up.railway.app) is treated the same way.
 * - unknown: any other veyrafy.com name (not a valid client address). "Not set up", nothing else.
 *
 * The address only chooses what to show. It never grants access: every instance serves exactly
 * one organization, and its API checks the signed-in session on every protected call.
 */
export const DOMAIN = 'veyrafy.com';
export const WEBSITE_ADDRESS = `https://${DOMAIN}/`;
export const DEMO_ADDRESS = `https://demo.${DOMAIN}/`;
/**
 * Where the 10 Invoice Challenge runs (a deployment with VEYRA_CHALLENGE=true and its own
 * database; the website has none). The website's challenge page starts it there.
 */
export const CHALLENGE_PATH = '/10-invoice-challenge';
export const CHALLENGE_ADDRESS = `https://demo.${DOMAIN}${CHALLENGE_PATH}`;

/** Whether this address is the challenge page (a path, or the app's hash form). */
export function isChallengePage(pathname: string, hash: string): boolean {
  return (
    pathname.replace(/\/+$/, '') === CHALLENGE_PATH ||
    hash.replace(/^#/, '').split(/[?&]/)[0]?.replace(/\/+$/, '') === CHALLENGE_PATH
  );
}
export const CONTACT_PHONE = '+91 98800 00990';
export const CONTACT_PHONE_HREF = 'tel:+919880000990';

const WEBSITE_HOSTS = new Set([DOMAIN, `www.${DOMAIN}`]);
const DEVELOPMENT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
/** Names that are never a client's address (infrastructure and look-alikes). */
const RESERVED = new Set([
  'www',
  'api',
  'app',
  'admin',
  'ops',
  'mail',
  'email',
  'status',
  'docs',
  'help',
  'support',
  'static',
  'assets',
  'cdn',
  'login',
  'auth',
  'veyrafy',
]);

export type HostKind =
  | { kind: 'website' }
  | { kind: 'development' }
  | { kind: 'client'; slug: string | null }
  | { kind: 'unknown' };

/**
 * A client's Veyrafy address (the "toit" of toit.veyrafy.com): 2–40 lowercase letters, digits and
 * single hyphens, starting and ending with a letter or digit, and not a reserved name.
 */
export function isValidClientSlug(slug: string): boolean {
  return (
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(slug) &&
    !slug.includes('--') &&
    !RESERVED.has(slug)
  );
}

export function classifyHost(hostname: string): HostKind {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (WEBSITE_HOSTS.has(host)) return { kind: 'website' };
  if (DEVELOPMENT_HOSTS.has(host)) return { kind: 'development' };
  if (host.endsWith(`.${DOMAIN}`)) {
    const label = host.slice(0, -(DOMAIN.length + 1));
    return !label.includes('.') && isValidClientSlug(label)
      ? { kind: 'client', slug: label }
      : { kind: 'unknown' };
  }
  return { kind: 'client', slug: null };
}

/**
 * What someone typed as their company's address, reduced to the slug: "Toit", "toit.veyrafy.com"
 * and "https://toit.veyrafy.com/" all give "toit". Null when it is not a valid client address.
 */
export function clientSlugFrom(input: string): string | null {
  let text = input.trim().toLowerCase();
  // A pasted full address keeps only its host name; otherwise no "/" may appear at all.
  const url = /^https?:\/\/([^/?#]+)(?:[/?#].*)?$/.exec(text);
  if (url) text = url[1] ?? '';
  const suffix = `.${DOMAIN}`;
  const slug = text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
  return isValidClientSlug(slug) ? slug : null;
}

export function clientAddress(slug: string): string {
  return `https://${slug}.${DOMAIN}/`;
}
