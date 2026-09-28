/**
 * @veyra/extractor: the Extractor port and its implementations. V1 ships the FixtureExtractor
 * (demo/test only). Local OCR and Ollama implementations are later phases.
 */
export const PACKAGE_NAME = '@veyra/extractor';

export * from './extractor';
export { FixtureExtractor, type FixtureExtractorOptions } from './fixture/fixture-extractor';
export {
  documentLines,
  renderScenario,
  scenarioExtraction,
  scenarioMime,
  sha256Hex,
} from './fixture/build';
export { DEMO_BUYER, SCENARIOS, scenarioById, type FixtureScenario } from './fixture/scenarios';
