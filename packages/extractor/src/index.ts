/**
 * @veyra/extractor: the Extractor port and its implementations: the LocalDocumentExtractor (PDF
 * text layer + Tesseract OCR, optional grounded Ollama assist) and the FixtureExtractor (demo and
 * tests only).
 */
export const PACKAGE_NAME = '@veyra/extractor';

export * from './extractor';
export { FixtureExtractor, type FixtureExtractorOptions } from './fixture/fixture-extractor';
export {
  LocalDocumentExtractor,
  sniffDocument,
  type LocalExtractorOptions,
} from './local/local-extractor';
export { checkImageSize, imageSize } from './local/image';
export {
  LIMITS as DOCUMENT_LIMITS,
  configureDocumentLimits,
  type ConfigurableDocumentLimits,
} from './local/limits';
export { OllamaAssist, OLLAMA_MAX_CONFIDENCE_BP, type OllamaOptions } from './local/ollama';
export { TesseractOcr, type OcrEngine, type OcrLine, type OcrWord } from './local/ocr';
export { DemoRoutedExtractor } from './routed';
export {
  BUYER,
  DOCUMENT_SAMPLES,
  type DocumentSample,
  type SampleInvoice,
} from './samples/documents';
export {
  documentLines,
  renderScenario,
  scenarioExtraction,
  scenarioMime,
  sha256Hex,
} from './fixture/build';
export { DEMO_BUYER, SCENARIOS, scenarioById, type FixtureScenario } from './fixture/scenarios';
