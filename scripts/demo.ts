/**
 * `npm run demo`: starts the Veyra API (fixture extractor, demo ERP seed) and the web app.
 * `npm run demo -- --reset` first wipes data/veyra so the demo starts from the DEMO.md seed.
 * `npm run demo -- --empty` starts from a business with only its company record, for the Excel
 * import demo (DEMO.md §6).
 * Open http://localhost:5173/#/app/inbox and upload invoices from fixtures/invoices.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.argv.includes('--reset')) rmSync(`${root}data/veyra`, { recursive: true, force: true });

const env = { ...process.env, VEYRA_ALLOW_FIXTURE_EXTRACTOR: 'true', VEYRA_DEMO: 'true' };
const children = [
  spawn('npm', ['run', 'start', '-w', '@veyra/api'], { cwd: root, env, stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '-w', '@veyra/web'], { cwd: root, env, stdio: 'inherit' }),
];
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => code && stop());

if (process.argv.includes('--empty')) {
  const api = 'http://127.0.0.1:8787/api/v1';
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`${api}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) {
      await fetch(`${api}/dev/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ erp: 'empty' }),
      });
      console.log('Started from an empty business: import records from fixtures/imports/.');
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
