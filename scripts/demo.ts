/**
 * `npm run demo`: starts the Veyra API (fixture extractor, demo ERP seed) and the web app.
 * `npm run demo -- --reset` first wipes data/veyra so the demo starts from the DEMO.md seed.
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
