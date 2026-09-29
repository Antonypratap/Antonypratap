/**
 * Browser benchmark (Phase 7, docs/PERFORMANCE.md "Browser").
 *
 * Needs the web production build served (`npm run preview -w @veyra/web`, port 4173) in front of a
 * running API with data, and a test-only account:
 *
 *   VEYRA_BENCH_EMAIL=finance@toit.example VEYRA_BENCH_PASSWORD=… node scripts/bench-browser.mjs <label>
 *
 * Measures, separately: bundle sizes; homepage load; for each product screen the time until it
 * shows its content and the API requests it makes; and the requests made while the inbox sits
 * idle (polling). Writes apps/api/bench/results/browser-<label>.json.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';

const label = process.argv[2] ?? 'run';
const base = process.env.VEYRA_BENCH_URL ?? 'http://localhost:4173/';
const email = process.env.VEYRA_BENCH_EMAIL;
const password = process.env.VEYRA_BENCH_PASSWORD;
if (!email || !password) throw new Error('VEYRA_BENCH_EMAIL and VEYRA_BENCH_PASSWORD are required');

const dist = new URL('../apps/web/dist/assets/', import.meta.url);
const bundle = readdirSync(dist)
  .filter((f) => /\.(js|css)$/.test(f))
  .map((f) => {
    const bytes = readFileSync(new URL(f, dist));
    return {
      file: f,
      kb: Math.round(statSync(new URL(f, dist)).size / 1024),
      gzipKb: Math.round(gzipSync(bytes).length / 1024),
    };
  })
  .sort((a, b) => b.kb - a.kb);

const browser = await chromium.launch({
  executablePath:
    process.env.VEYRA_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const requests = [];
page.on('request', (r) => {
  if (r.url().includes('/api/'))
    requests.push({
      t: Date.now(),
      url: new URL(r.url()).pathname + new URL(r.url()).search,
      method: r.method(),
    });
});
const scripts = [];
page.on('response', async (r) => {
  if (/\.(js|css)$/.test(r.url()))
    scripts.push({
      url: new URL(r.url()).pathname,
      kb: Math.round((await r.body().catch(() => Buffer.alloc(0))).length / 1024),
    });
});

// Homepage: public, no product code needed.
let t0 = Date.now();
await page.goto(base, { waitUntil: 'load' });
await page.getByRole('heading', { name: 'Invoices, handled.' }).waitFor();
const homepage = {
  msToContent: Date.now() - t0,
  assetsKb: scripts.reduce((a, s) => a + s.kb, 0),
  assets: scripts.map((s) => s.url),
};

// Sign in (through the UI, as a person would).
await page.goto(`${base}#/app/inbox`);
await page.locator('form h1').waitFor();
const emailLink = page.getByRole('button', { name: 'Sign in with email instead' });
if (await emailLink.isVisible().catch(() => false)) await emailLink.click();
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.locator('[class*="needsNumber"]').waitFor();

async function screen(name, hash, ready) {
  await page.goto(`${base}#/`); // leave the product: the next navigation loads it afresh
  await page.waitForTimeout(300);
  requests.length = 0;
  const start = Date.now();
  await page.goto(`${base}${hash}`);
  await ready();
  const ms = Date.now() - start;
  await page.waitForTimeout(1500); // anything fired right after showing the content
  const urls = requests.map((r) => `${r.method} ${r.url}`);
  const duplicates = urls.length - new Set(urls).size;
  return {
    name,
    msToContent: ms,
    apiRequests: urls.length,
    duplicateRequests: duplicates,
    requests: urls,
  };
}

const firstInvoice = await page.evaluate(async () => {
  const r = await fetch('/api/v1/invoices');
  return (await r.json()).invoices[0]?.id;
});
const screens = [
  await screen('inbox', '#/app/inbox', () => page.locator('[class*="needsNumber"]').waitFor()),
  await screen('invoices', '#/app/invoices', () =>
    page.locator('table, [class*="row"]').first().waitFor(),
  ),
  await screen('invoice detail', `#/app/invoices/${firstInvoice}`, () =>
    page.locator('h1').first().waitFor(),
  ),
  await screen('questions', '#/app/questions', () => page.locator('h1').first().waitFor()),
  await screen('audit', '#/app/audit', () => page.locator('h1').first().waitFor()),
  await screen('erp vendors', '#/app/erp/vendors', () => page.locator('table').first().waitFor()),
];

// Idle polling on the inbox, nothing processing: requests per minute.
await page.goto(`${base}#/app/inbox`);
await page.locator('[class*="needsNumber"]').waitFor();
await page.waitForTimeout(1000);
requests.length = 0;
await page.waitForTimeout(20_000);
const idle = {
  seconds: 20,
  apiRequests: requests.length,
  perMinute: Math.round((requests.length * 60) / 20),
  byUrl: requests.reduce((acc, r) => ({ ...acc, [r.url]: (acc[r.url] ?? 0) + 1 }), {}),
};
// Idle on an invoice detail: its own data should not reload when nothing changed.
await page.goto(`${base}#/app/invoices/${firstInvoice}`);
await page.locator('h1').first().waitFor();
await page.waitForTimeout(1000);
requests.length = 0;
await page.waitForTimeout(20_000);
const idleDetail = {
  seconds: 20,
  apiRequests: requests.length,
  byUrl: requests.reduce((acc, r) => ({ ...acc, [r.url]: (acc[r.url] ?? 0) + 1 }), {}),
};

await browser.close();
const out = { label, at: new Date().toISOString(), bundle, homepage, screens, idle, idleDetail };
writeFileSync(
  new URL(`../apps/api/bench/results/browser-${label}.json`, import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      bundle: bundle.slice(0, 4),
      homepage,
      screens: screens.map((s) => ({ ...s, requests: s.requests.length })),
      idle,
      idleDetail,
    },
    null,
    1,
  ),
);
