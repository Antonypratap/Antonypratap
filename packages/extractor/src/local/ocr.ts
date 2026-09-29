import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ExtractorError } from '../extractor';
import { LIMITS } from './limits';

/** One word as the OCR engine read it, in image pixels, with its confidence 0–100. */
export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  conf: number;
}

export interface OcrLine {
  words: OcrWord[];
}

/** The OCR port used by the local extractor (Tesseract here; a fake in unit tests). */
export interface OcrEngine {
  readonly name: string;
  readonly version: string;
  recognize(png: Uint8Array): Promise<OcrLine[]>;
  close(): Promise<void>;
  /** Starts the engine ahead of the first document (optional). */
  warmUp?(): Promise<void>;
}

interface TesseractWorker {
  setParameters(p: Record<string, string>): Promise<unknown>;
  recognize(
    image: Buffer,
    options: Record<string, never>,
    output: { blocks: true; text: false },
  ): Promise<{
    data: {
      blocks:
        | {
            paragraphs: {
              lines: {
                words: {
                  text: string;
                  confidence: number;
                  bbox: { x0: number; y0: number; x1: number; y1: number };
                }[];
              }[];
            }[];
          }[]
        | null;
    };
  }>;
  terminate(): Promise<unknown>;
}

/**
 * Tesseract OCR through tesseract.js (Tesseract compiled to WebAssembly): free, local, and no
 * system install. The English model ships in the `@tesseract.js-data/eng` npm package, so nothing
 * is downloaded at run time. One worker is started on first use and reused.
 *
 * Page segmentation mode 11 (sparse text) reads invoice layouts (blocks, tables, totals) better
 * than the default full-page mode.
 */
export class TesseractOcr implements OcrEngine {
  readonly name = 'tesseract';
  readonly version: string;
  #worker: Promise<TesseractWorker> | null = null;
  readonly #langPath: string;

  constructor() {
    const require = createRequire(import.meta.url);
    this.version = (require('tesseract.js/package.json') as { version: string }).version;
    this.#langPath = join(
      dirname(require.resolve('@tesseract.js-data/eng/package.json')),
      '4.0.0_best_int',
    );
  }

  async #get(): Promise<TesseractWorker> {
    this.#worker ??= (async () => {
      const { createWorker } = (await import('tesseract.js')) as unknown as {
        createWorker: (
          lang: string,
          oem: number,
          options: Record<string, unknown>,
        ) => Promise<TesseractWorker>;
      };
      const worker = await createWorker('eng', 1, {
        langPath: this.#langPath,
        cacheMethod: 'none',
        gzip: true,
        logger: () => undefined,
        errorHandler: () => undefined,
      });
      await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
      return worker;
    })().catch((error: unknown) => {
      this.#worker = null;
      throw new ExtractorError(
        'OCR_UNAVAILABLE',
        `OCR could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.#worker;
  }

  /** Starts the Tesseract worker now instead of on the first image (Phase 7). */
  async warmUp(): Promise<void> {
    await this.#get();
  }

  async recognize(png: Uint8Array): Promise<OcrLine[]> {
    const worker = await this.#get();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ExtractorError('OCR_FAILED', 'OCR took too long on a page.')),
        LIMITS.ocrTimeoutMs,
      );
    });
    try {
      const { data } = await Promise.race([
        worker.recognize(Buffer.from(png), {}, { blocks: true, text: false }),
        timeout,
      ]);
      return (data.blocks ?? []).flatMap((b) =>
        b.paragraphs.flatMap((p) =>
          p.lines.map((l) => ({
            words: l.words.map((w) => ({ text: w.text, conf: w.confidence, ...w.bbox })),
          })),
        ),
      );
    } catch (error) {
      if (error instanceof ExtractorError) {
        // A stuck worker is not reused.
        await this.close();
        throw error;
      }
      throw new ExtractorError(
        'OCR_FAILED',
        `OCR could not read a page: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    const w = this.#worker;
    this.#worker = null;
    if (w) await w.then((x) => x.terminate()).catch(() => undefined);
  }
}
