/**
 * Writes the demo invoice documents to fixtures/invoices (docs/DEMO.md §4).
 * `npm run fixtures:generate`. The output is deterministic; a test checks the committed files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from '../fixture/scenarios';
import { renderScenario, sha256Hex } from '../fixture/build';

const dir = fileURLToPath(new URL('../../../../fixtures/invoices/', import.meta.url));
mkdirSync(dir, { recursive: true });
for (const s of SCENARIOS) {
  const bytes = renderScenario(s);
  writeFileSync(`${dir}${s.file}`, bytes);
  console.log(`${s.file.padEnd(32)} ${sha256Hex(bytes).slice(0, 12)}  ${s.title}`);
}
