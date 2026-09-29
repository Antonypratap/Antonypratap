/**
 * Fills a RUNNING Veyra (dev or staging, never production) with realistic synthetic invoices
 * through its API, for the browser benchmark (scripts/bench-browser.mjs). Test-only account:
 *
 *   VEYRA_BENCH_EMAIL=… VEYRA_BENCH_PASSWORD=… npx tsx bench/seed.ts [count] [api base]
 */
import { closeRenderer, realisticMany } from './documents';

const count = Number(process.argv[2] ?? 40);
const base = process.argv[3] ?? 'http://127.0.0.1:8787/api/v1';
const email = process.env.VEYRA_BENCH_EMAIL;
const password = process.env.VEYRA_BENCH_PASSWORD;
if (!email || !password) throw new Error('VEYRA_BENCH_EMAIL and VEYRA_BENCH_PASSWORD are required');

const login = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) throw new Error(`sign-in failed: ${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
const { csrfToken } = (await login.json()) as { csrfToken: string };
const mix = ['D01', 'D07', 'D08', 'D09', 'D10', 'D12', 'D06', 'D03', 'D02'];
const docs = await realisticMany(
  Array.from({ length: count }, (_, i) => mix[i % mix.length] ?? 'D01'),
);
await closeRenderer();
for (const d of docs) {
  const form = new FormData();
  form.append('file', new Blob([d.bytes], { type: d.mime }), d.file);
  const r = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { cookie, 'x-veyra-csrf': csrfToken },
    body: form,
  });
  if (r.status !== 201) throw new Error(`upload ${r.status}`);
}
for (;;) {
  const r = (await (await fetch(`${base}/invoices`, { headers: { cookie } })).json()) as {
    counts: { processing: number; received: number };
  };
  if (r.counts.processing === 0) {
    console.log(`seeded: ${r.counts.received} invoices`);
    break;
  }
  await new Promise((res) => setTimeout(res, 500));
}
