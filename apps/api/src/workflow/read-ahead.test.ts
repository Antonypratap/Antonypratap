import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureExtractor, renderScenario, scenarioById, type Extractor } from '@veyra/extractor';
import type { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';

/**
 * Several invoices uploaded together are read at the same time (reading is the slow part: an AI
 * call or OCR), while checking and recording stay one at a time. Made-up fixture invoices.
 */
const fixture = new FixtureExtractor({ allow: true, nodeEnv: 'test' });
let running = 0;
let most = 0;
let calls = 0;
const slow: Extractor = {
  id: fixture.id,
  version: fixture.version,
  isAvailable: () => fixture.isAvailable(),
  extract: async (input) => {
    calls++;
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 400));
    running--;
    return fixture.extract(input);
  },
};

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-read-ahead-'));
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    demoBusiness: 'manufacturing',
    allowFixtureExtractor: false,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
    documentExtractor: slow,
    readAhead: 3,
  });
  app.runner.stop();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reading several invoices at once', () => {
  it('three uploads are read together, each once, and all are processed', async () => {
    const started = Date.now();
    const ids: string[] = [];
    for (const id of ['S01', 'S02', 'S03']) {
      const s = scenarioById(id);
      if (!s) throw new Error(id);
      ids.push((await app.veyra.upload({ filename: s.file, bytes: renderScenario(s) })).invoiceId);
    }
    await app.runner.drain();
    expect(most).toBe(3); // read at the same time, not one after another
    expect(calls).toBe(3); // each document read once: the pipeline used the reading started ahead
    expect(Date.now() - started).toBeLessThan(3 * 400 + 800);
    for (const id of ids)
      expect((await app.veyra.invoiceRow(app.veyra.db, id)).state).not.toMatch(
        /UPLOADED|EXTRACTING|FAILED/,
      );
  });
});
