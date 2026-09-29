/**
 * End-to-end check of a HOSTED demo (Phase 7C, docs/DEPLOYMENT.md §14, docs/DEMO.md §9): the
 * public journey in a real browser against the deployed URL, not localhost.
 *
 *   VEYRA_DEMO_URL=https://veyra-demo.vercel.app/ VEYRA_DEMO_PIN=… RESET=1 \
 *     node scripts/demo-check.mjs
 *
 * RESET=1 first resets the demo (Demo scenarios → Reset demo), which every visitor will notice;
 * without it the scenario outcomes are only checked loosely, because earlier visitors may have
 * answered them already. The PIN comes from the environment and is never printed. Needs Chromium
 * (VEYRA_CHROMIUM=/path/to/chrome, or a Playwright browser). Exit code 1 on any failure.
 */
/* global document -- the init script runs in the page */
import { chromium } from 'playwright-core';

const base = new URL(process.env.VEYRA_DEMO_URL ?? 'http://localhost:4173/').href;
const PIN = process.env.VEYRA_DEMO_PIN;
if (!PIN) throw new Error('VEYRA_DEMO_PIN is required');
const reset = process.env.RESET === '1';
const browser = await chromium.launch({
  executablePath:
    process.env.VEYRA_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
let failed = 0;
const ok = (c, m) => {
  console.log(c ? 'PASS' : 'FAIL', m);
  if (!c) failed++;
};
const errors = [];
const csp = [];
const apiBodies = [];
const scripts = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() =>
  document.addEventListener('securitypolicyviolation', (e) =>
    console.error(`CSP-VIOLATION ${e.violatedDirective} ${e.blockedURI}`),
  ),
);
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') (m.text().includes('CSP') ? csp : errors).push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', async (r) => {
  const url = r.url();
  try {
    if (url.includes('/api/')) apiBodies.push(await r.text());
    else if (url.endsWith('.js')) scripts.push(await r.text());
  } catch {
    /* a body that is gone (navigation) */
  }
});
const api = (method, path) => page.request.fetch(`${base}api/v1${path}`, { method });
const inbox = async () => (await api('GET', '/invoices')).json();
const until = async (check, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(500))
    if (await check()) return true;
  return false;
};

// 1. Landing page: public, with the security headers
const home = await page.goto(base, { waitUntil: 'networkidle' });
const h = home?.headers() ?? {};
ok(home?.status() === 200, `landing page answers (${home?.status()})`);
ok(
  /default-src 'self'/.test(h['content-security-policy'] ?? '') &&
    h['x-frame-options'] === 'DENY' &&
    h['x-content-type-options'] === 'nosniff',
  'landing page sends the CSP and companion headers',
);
ok(
  base.startsWith('http://localhost') || !!h['strict-transport-security'],
  'HSTS on the public site',
);

// 2. "See Veyra in action" → demo PIN → inbox
await page.getByRole('link', { name: 'See Veyra in action' }).first().click();
await page.getByLabel('PIN').waitFor({ timeout: 15_000 });
ok(new URL(page.url()).hash.startsWith('#/app'), '"See Veyra in action" opens the demo sign-in');
await page.getByLabel('PIN').fill('000000');
await page.getByRole('button', { name: 'Open demo' }).click();
ok(
  await page
    .getByText('That PIN isn’t correct.')
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    ),
  'a wrong PIN is refused by the server',
);
await page.getByLabel('PIN').fill(PIN);
await page.getByRole('button', { name: 'Open demo' }).click();
ok(
  await page
    .getByText('need you')
    .first()
    .waitFor({ timeout: 20_000 })
    .then(
      () => true,
      () => false,
    ),
  'the PIN opens the inbox',
);
const cookie = (await ctx.cookies()).find((c) => c.name.endsWith('veyra_session'));
ok(
  !!cookie &&
    cookie.httpOnly &&
    cookie.sameSite === 'Strict' &&
    (cookie.secure || base.startsWith('http://localhost')),
  `session cookie: first-party, HttpOnly, SameSite=Strict${cookie?.secure ? ', Secure' : ''}`,
);

// 3. A product address as a path (a shared link or a refresh)
await page.goto(`${base}app/inbox`, { waitUntil: 'networkidle' });
ok(
  new URL(page.url()).hash === '#/app/inbox' &&
    (await page.getByText('need you').first().isVisible()),
  '/app/inbox opened directly (refresh) shows the inbox',
);

// 4. Optionally reset, then the seven demo scenarios through the demo panel
const openPanel = async () => {
  await page.goto(`${base}#/app/inbox`);
  await page.getByRole('button', { name: 'Demo scenarios' }).click();
};
if (reset) {
  await openPanel();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset demo' }).click();
  await page.getByRole('button', { name: 'Yes, reset the demo' }).click();
  ok(
    await until(async () => (await inbox()).invoices.length === 0, 30_000),
    'demo reset (server side)',
  );
}
const SCENARIOS = [
  ['Clean invoice', 'handled'],
  ['Missing goods receipt', 'attention'],
  ['Ambiguous supplier', 'attention'],
  ['Quantity mismatch', 'attention'],
  ['Rate mismatch', 'attention'],
  ['Photo needs confirmation', 'attention'],
  ['Two invoices in one file', 'attention'],
];
const ids = new Map();
for (const [title] of SCENARIOS) {
  await openPanel();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(title) })
    .click();
  await page.waitForURL(/#\/app\/invoices\/[0-9A-Z]+/, { timeout: 30_000 });
  ids.set(title, new URL(page.url()).hash.split('/').pop());
}
ok(
  await until(async () =>
    (await inbox()).invoices.every(
      (i) => ![...ids.values()].includes(i.id) || i.status !== 'processing',
    ),
  ),
  'every scenario invoice was read and settled (the worker runs)',
);
const now = await inbox();
for (const [title, expected] of SCENARIOS) {
  const inv = now.invoices.find((i) => i.id === ids.get(title));
  const got = inv?.status;
  ok(
    reset ? got === expected : got !== undefined && got !== 'processing',
    `${title}: ${got}/${inv?.state}${reset ? ` (expected ${expected})` : ''}`,
  );
}

// 5. Answer a question: the missing goods receipt → recorded → verified
const grnId = ids.get('Missing goods receipt');
await page.goto(`${base}#/app/invoices/${grnId}`);
const ask = page.getByRole('button', { name: 'Yes, record the receipt' });
if (
  await ask.waitFor({ timeout: 10_000 }).then(
    () => true,
    () => false,
  )
) {
  await ask.click();
  await page.getByRole('button', { name: 'Fill with the invoiced quantities' }).click();
  const min = await page.locator('input[type=date]').getAttribute('min');
  if (min) await page.locator('input[type=date]').fill(min);
  await page.locator('form').getByRole('button', { name: 'Yes, record the receipt' }).click();
  ok(
    await until(
      async () =>
        (await inbox()).invoices.find((i) => i.id === grnId)?.state === 'VERIFIED_PENDING_PAYMENT',
    ),
    'answered: the goods receipt is recorded in the ERP and the invoice verified',
  );
} else ok(!reset, 'the goods-receipt question was already answered (no RESET)');

// 6. Audit trail and ERP demo data
await page.goto(`${base}#/app/audit`);
const audit = await (await api('GET', '/audit')).json();
ok(Array.isArray(audit) && audit.length > 0, `audit trail (${audit.length} entries)`);
await page.goto(`${base}#/app/erp/vendors`);
ok(
  await page
    .locator('table tbody tr')
    .first()
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    ),
  'ERP demo data (vendors) shown',
);
const erpInvoices = await (await api('GET', '/erp/purchase-invoices')).json();
ok(
  Array.isArray(erpInvoices) && erpInvoices.length > 0,
  `purchase invoices Veyra recorded in the ERP (${erpInvoices.length})`,
);

// 7. Nothing destructive or diagnostic answers anonymous callers
const anon = await browser.newContext();
const call = (method, path, headers = {}) =>
  anon.request.fetch(`${base}api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    data: method === 'POST' ? '{}' : undefined,
  });
ok((await call('POST', '/dev/reset')).status() === 401, 'anonymous demo reset refused (401)');
ok((await call('GET', '/system/status')).status() === 401, 'anonymous system status refused (401)');
const health = await (await call('GET', '/health')).json();
ok(
  JSON.stringify(Object.keys(health).sort()) === '["demo","ok"]',
  'public /health holds statuses only',
);
const ready = await (await call('GET', '/health/ready')).json();
ok(
  !('jobs' in ready) && !('pool' in ready) && !('environment' in ready),
  'public /health/ready holds statuses only',
);
const evil = await call('POST', '/auth/demo', { origin: 'https://evil.example' });
ok(evil.status() === 403, `sign-in from another origin refused (${evil.status()})`);
await anon.close();

// 8. Hygiene: no PIN or infrastructure detail anywhere the browser saw
ok(
  !scripts.join('\n').includes(PIN) && !(await page.content()).includes(PIN),
  `the PIN is in none of the ${scripts.length} scripts or the page`,
);
ok(
  !/https?:\/\/(localhost|127\.0\.0\.1)/.test(scripts.join('\n')) ||
    base.startsWith('http://localhost'),
  'no localhost API address in the scripts',
);
ok(
  !apiBodies.join('\n').includes(PIN) &&
    !/postgres(ql)?:\/\/|\bat \S+\.ts:\d+|\/var\/lib\//.test(apiBodies.join('\n')),
  `no PIN, database URL, path or stack trace in ${apiBodies.length} API responses`,
);
ok(csp.length === 0, `no CSP violations ${csp.slice(0, 2).join(' | ')}`);
const unexpected = errors.filter((e) => !/status of (401|403)/.test(e));
ok(unexpected.length === 0, `no unexpected console errors ${unexpected.slice(0, 2).join(' | ')}`);
await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
