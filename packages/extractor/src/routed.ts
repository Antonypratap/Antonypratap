import type { ExtractionResult } from '@veyra/shared';
import type { Extractor, ExtractorInput } from './extractor';
import type { FixtureExtractor } from './fixture/fixture-extractor';

/**
 * DEMO ONLY: the demo's sample invoices (`fixtures/invoices/`, recognised by SHA-256) keep their
 * scripted, deterministic reading so the demo scenarios and regression tests stay exact; every
 * other document goes through the real extractor. Production uses the real extractor alone.
 */
export class DemoRoutedExtractor implements Extractor {
  readonly id: Extractor['id'];
  readonly version: string;

  constructor(
    private readonly fixture: FixtureExtractor,
    private readonly real: Extractor,
  ) {
    this.id = real.id;
    this.version = real.version;
  }

  isAvailable() {
    return this.real.isAvailable();
  }

  extract(input: ExtractorInput): Promise<ExtractionResult> {
    return this.fixture.scenarioFor(input.sha256)
      ? this.fixture.extract(input)
      : this.real.extract(input);
  }
}
