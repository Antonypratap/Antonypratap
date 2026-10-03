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
  renderPdfPage,
  sniffDocument,
  type LocalExtractorOptions,
} from './local/local-extractor';
export { checkImageSize, imageSize } from './local/image';
export { detectRotation, uprightImage, type Rotation } from './local/orientation';
/** Test support: a PDF turned into image strips with no text layer (synthetic fixtures only). */
export { imageOnlyStripPdf } from './local/image-only-pdf';
export {
  LIMITS as DOCUMENT_LIMITS,
  configureDocumentLimits,
  type ConfigurableDocumentLimits,
} from './local/limits';
export { OllamaAssist, OLLAMA_MAX_CONFIDENCE_BP, type OllamaOptions } from './local/ollama';
export { TesseractOcr, type OcrEngine, type OcrLine, type OcrWord } from './local/ocr';
export { DemoRoutedExtractor } from './routed';
export {
  AI_CONFIDENCE_BP,
  GeminiExtractor,
  toExtraction,
  type AiReading,
  type GeminiOptions,
} from './ai/gemini';
export {
  BUYER,
  DOCUMENT_SAMPLES,
  type DocumentSample,
  type SampleBuyer,
  type SampleInvoice,
} from './samples/documents';
export { BREWERY_BUYER, BREWERY_DOCUMENT_SAMPLES } from './samples/brewery-documents';
export {
  documentLines,
  renderScenario,
  scenarioExtraction,
  scenarioMime,
  sha256Hex,
} from './fixture/build';
export { DEMO_BUYER, SCENARIOS, scenarioById, type FixtureScenario } from './fixture/scenarios';
