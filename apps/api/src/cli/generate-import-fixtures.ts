/**
 * Writes fixtures/imports: the downloadable templates and demo business records (the DEMO.md
 * seed, exported in template format), split the way a business would provide them.
 * `npm run fixtures:generate`. Deterministic; a test checks the committed files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importFixtures } from '../imports/fixtures';

const dir = fileURLToPath(new URL('../../../../fixtures/imports/', import.meta.url));
mkdirSync(`${dir}templates`, { recursive: true });
for (const [name, bytes] of await importFixtures()) {
  writeFileSync(`${dir}${name}`, bytes);
  console.log(name);
}
