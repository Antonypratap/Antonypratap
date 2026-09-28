import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importFixtures } from './fixtures';

describe('fixtures/imports', () => {
  it('committed templates and demo files are exactly what the generator writes', async () => {
    for (const [name, bytes] of await importFixtures()) {
      const onDisk = readFileSync(new URL(`../../../../fixtures/imports/${name}`, import.meta.url));
      expect(onDisk.equals(bytes), name).toBe(true);
    }
  });
});
