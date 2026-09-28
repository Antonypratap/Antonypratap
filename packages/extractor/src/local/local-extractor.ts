import { readFile } from 'node:fs/promises';
import { ExtractionResultSchema, type ExtractionResult } from '@veyra/shared';
import { ExtractorError, type Extractor, type ExtractorInput } from '../extractor';
import { decodeImage, encodePng, removeRules } from './image';
import { wordsToSegments, type PageText } from './layout';
import type { OllamaAssist } from './ollama';
import { TesseractOcr, type OcrEngine } from './ocr';
import { parseInvoice } from './parse';

export interface LocalExtractorOptions {
  /** Defaults to Tesseract (tesseract.js). Tests may pass a fake engine. */
  ocr?: OcrEngine;
  /** Optional local Ollama assist, grounded in the document text. Off unless configured. */
  ollama?: OllamaAssist | null;
}

/** What the file is, from its bytes: never from its name or a client-supplied MIME type. */
export function sniffDocument(
  bytes: Uint8Array,
): 'application/pdf' | 'image/png' | 'image/jpeg' | null {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46 && b(4) === 0x2d)
    return 'application/pdf';
  if (
    b(0) === 0x89 &&
    b(1) === 0x50 &&
    b(2) === 0x4e &&
    b(3) === 0x47 &&
    b(4) === 0x0d &&
    b(5) === 0x0a
  )
    return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  return null;
}

/**
 * The real, local document extractor (Phase 3D). Free and offline:
 *
 * - PDF with a text layer → the text is read exactly (`pdf_text`).
 * - Scanned PDF pages, PNG and JPEG → Tesseract OCR (`tesseract`), after removing table rules.
 * - Optionally, a local Ollama model may propose values for fields the parser left empty, but
 *   only values that appear verbatim in the document text, at low confidence (`ollama`).
 *
 * The result is a proposal. The workflow validates it with `ExtractionResultSchema`, and the
 * deterministic core decides what is usable; nothing here matches, creates or approves anything.
 */
export class LocalDocumentExtractor implements Extractor {
  readonly id = 'local_ocr' as const;
  readonly version = '1';
  readonly #ocr: OcrEngine;
  readonly #ollama: OllamaAssist | null;

  constructor(options: LocalExtractorOptions = {}) {
    this.#ocr = options.ocr ?? new TesseractOcr();
    this.#ollama = options.ollama ?? null;
  }

  async isAvailable(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async extract(input: ExtractorInput): Promise<ExtractionResult> {
    const bytes = new Uint8Array(await readFile(input.filePath));
    const mime = sniffDocument(bytes);
    if (!mime || mime !== input.mime)
      throw new ExtractorError(
        'UNSUPPORTED_MIME',
        'The file is not the PDF, PNG or JPEG it was stored as.',
      );
    return this.extractBytes(bytes, mime);
  }

  async extractBytes(
    bytes: Uint8Array,
    mime: 'application/pdf' | 'image/png' | 'image/jpeg',
  ): Promise<ExtractionResult> {
    let pages: PageText[];
    const warnings: string[] = [];
    if (mime === 'application/pdf') {
      const { readPdf } = await import('./pdf');
      const read = await readPdf(bytes, this.#ocr);
      pages = read.pages;
      warnings.push(...read.warnings);
    } else {
      const lines = await this.#ocr.recognize(encodePng(removeRules(decodeImage(bytes, mime))));
      pages = [{ page: 1, segments: wordsToSegments(lines, 1) }];
      warnings.push('Read by OCR.');
    }
    const parsed = parseInvoice(pages);
    warnings.push(...parsed.warnings);
    let { header, lines } = parsed;
    if (this.#ollama) {
      const assisted = await this.#ollama.fill({ header, lines }, pages);
      header = assisted.header;
      lines = assisted.lines;
      warnings.push(...assisted.warnings);
    }
    return ExtractionResultSchema.parse({
      extractor: { id: this.id, version: `${this.version}+${this.#ocr.name}-${this.#ocr.version}` },
      header,
      lines,
      pages: pages.length,
      warnings,
    });
  }

  async close(): Promise<void> {
    await this.#ocr.close();
  }
}
