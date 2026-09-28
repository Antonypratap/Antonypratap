import type { ExtractionResult } from '@veyra/shared';
import { ExtractorError, type Extractor, type ExtractorInput } from '../extractor';
import { renderScenario, scenarioExtraction, scenarioMime, sha256Hex } from './build';
import { SCENARIOS, type FixtureScenario } from './scenarios';

export interface FixtureExtractorOptions {
  /** Must be true: set from `VEYRA_ALLOW_FIXTURE_EXTRACTOR=true`. */
  allow: boolean;
  /** `process.env.NODE_ENV`. The fixture extractor refuses to exist in production. */
  nodeEnv: string | undefined;
}

/**
 * DEMO AND TEST ONLY. Recognises the demo fixture documents by SHA-256 and returns what is
 * printed on them, so the whole workflow can be exercised deterministically. It does not read
 * arbitrary documents: any other file is an error (the invoice then fails, it is never guessed).
 */
export class FixtureExtractor implements Extractor {
  readonly id = 'fixture' as const;
  readonly version = '1';
  readonly #bySha: ReadonlyMap<string, FixtureScenario>;

  constructor(options: FixtureExtractorOptions) {
    if (options.nodeEnv === 'production') {
      throw new ExtractorError('NOT_ALLOWED', 'The fixture extractor is never used in production.');
    }
    if (!options.allow) {
      throw new ExtractorError(
        'NOT_ALLOWED',
        'The fixture extractor is demo/test only. Set VEYRA_ALLOW_FIXTURE_EXTRACTOR=true to use it.',
      );
    }
    this.#bySha = new Map(SCENARIOS.map((s) => [sha256Hex(renderScenario(s)), s]));
  }

  async isAvailable(): Promise<{ ok: true }> {
    return { ok: true };
  }

  /** The scenario a document is, or null. */
  scenarioFor(sha256: string): FixtureScenario | null {
    return this.#bySha.get(sha256) ?? null;
  }

  async extract(input: ExtractorInput): Promise<ExtractionResult> {
    const scenario = this.#bySha.get(input.sha256);
    if (!scenario) {
      throw new ExtractorError(
        'UNKNOWN_DOCUMENT',
        'This demo reads only the sample invoices in fixtures/invoices.',
      );
    }
    if (scenarioMime(scenario) !== input.mime) {
      throw new ExtractorError('UNSUPPORTED_MIME', `Expected ${scenarioMime(scenario)}.`);
    }
    return scenarioExtraction(scenario);
  }
}
