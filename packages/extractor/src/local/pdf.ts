import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { ExtractorError } from '../extractor';
import { downscale, encodePng, grayFromPdfImage, ocrScaleFactor, removeRules } from './image';
import { textRunsToSegments, wordsToSegments, type PageText } from './layout';
import { LIMITS } from './limits';
import type { OcrEngine } from './ocr';

interface PdfImage {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{
    items: { str?: string; transform?: number[]; width?: number; height?: number }[];
  }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: { get(name: string, callback: (img: PdfImage | null) => void): void };
  cleanup(): void;
}

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

interface PdfJs {
  getDocument(src: Record<string, unknown>): {
    promise: Promise<PdfDocument>;
    destroy(): Promise<void>;
  };
  OPS: { paintImageXObject: number; paintInlineImageXObject: number };
}

/**
 * pdf.js's WebAssembly image decoders (CCITT fax and JBIG2 for 1-bit office scans, OpenJPEG for
 * JPEG 2000), shipped inside the `pdfjs-dist` package. Without this directory pdf.js cannot
 * decode those page images and a scanned PDF reads as "no image". Resolved from
 * the installed package, so it is wherever the extractor runs (dev, tests, the API image).
 */
export const PDFJS_WASM_DIR: string =
  join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'wasm') + sep;

/** The decoders the extractor relies on; checked by a test and by `pdfDecodersAvailable`. */
export const PDFJS_WASM_FILES = ['jbig2.wasm', 'openjpeg.wasm'] as const;

export const pdfDecodersAvailable = (): boolean =>
  PDFJS_WASM_FILES.every((f) => existsSync(join(PDFJS_WASM_DIR, f)));

let pdfjs: Promise<PdfJs> | null = null;
/** Loads pdf.js once per process (about a second on first use; see warmUp). */
export const loadPdfJs = (): Promise<PdfJs> =>
  (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJs>);

/**
 * Reads every page of a PDF into positioned text. A page with a real text layer is read from it
 * (`pdf_text`, exact). A page without one (a scan) has its page image OCR'd (`tesseract`).
 *
 * pdf.js runs with scripting and `eval` disabled, no font loading, and a decoded-image size cap:
 * the PDF is data, never code.
 */
export async function readPdf(
  bytes: Uint8Array,
  ocr: OcrEngine,
): Promise<{ pages: PageText[]; warnings: string[] }> {
  const lib = await loadPdfJs();
  let doc: PdfDocument;
  const task = lib.getDocument({
    data: Uint8Array.from(bytes),
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    stopAtErrors: true,
    maxImageSize: LIMITS.maxImagePixels,
    wasmUrl: PDFJS_WASM_DIR,
    verbosity: 0,
  });
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => undefined);
    const encrypted = error instanceof Error && error.name === 'PasswordException';
    throw new ExtractorError(
      'MALFORMED_DOCUMENT',
      encrypted
        ? 'The PDF is password-protected. Upload an unprotected copy.'
        : 'The PDF could not be read. It may be damaged or incomplete.',
    );
  }
  try {
    if (doc.numPages > LIMITS.maxPdfPages)
      throw new ExtractorError(
        'DOCUMENT_TOO_LARGE',
        `The PDF has ${doc.numPages} pages. Invoices up to ${LIMITS.maxPdfPages} pages are read.`,
      );
    const pages: PageText[] = [];
    const warnings: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const { height } = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const runs = content.items
          .filter((i) => typeof i.str === 'string' && i.transform)
          .map((i) => {
            const [, , , , x = 0, y = 0] = i.transform ?? [];
            const h = i.height ?? 0;
            return {
              page: n,
              text: i.str ?? '',
              x0: x,
              x1: x + (i.width ?? 0),
              y0: height - y - h,
              y1: height - y,
            };
          });
        const chars = runs.reduce((c, r) => c + r.text.replace(/\s/g, '').length, 0);
        if (chars >= LIMITS.minTextCharsPerPage) {
          pages.push({ page: n, segments: textRunsToSegments(runs) });
          continue;
        }
        const { image, undecodable } = await largestImage(lib, page);
        if (!image) {
          warnings.push(
            undecodable > 0
              ? `Page ${n} is a scan whose image could not be decoded.`
              : `Page ${n} has no text and no image to read.`,
          );
          pages.push({ page: n, segments: [] });
          continue;
        }
        // A page image's resolution follows from the page size: 600-dpi scans are halved.
        const { width: pageWidthPt } = page.getViewport({ scale: 1 });
        const dpi = pageWidthPt > 0 ? image.width / (pageWidthPt / 72) : NaN;
        const lines = await ocr.recognize(
          encodePng(removeRules(downscale(grayFromPdfImage(image), ocrScaleFactor(dpi)))),
        );
        pages.push({ page: n, segments: wordsToSegments(lines, n) });
        warnings.push(`Page ${n} is a scan: read by OCR.`);
      } finally {
        page.cleanup();
      }
    }
    return { pages, warnings };
  } catch (error) {
    if (error instanceof ExtractorError) throw error;
    throw new ExtractorError(
      'MALFORMED_DOCUMENT',
      `The PDF could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await task.destroy();
  }
}

/**
 * The largest image painted on a page (for a scan, the page itself), and how many painted images
 * pdf.js could not decode (so "no image" and "an image we cannot decode" are told apart).
 */
async function largestImage(
  lib: PdfJs,
  page: PdfPage,
): Promise<{ image: PdfImage | null; undecodable: number }> {
  const ops = await page.getOperatorList();
  let best: PdfImage | null = null;
  let undecodable = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    let img: PdfImage | null = null;
    if (fn === lib.OPS.paintImageXObject) {
      const name = ops.argsArray[i]?.[0];
      if (typeof name === 'string')
        img = await new Promise<PdfImage | null>((resolve) => page.objs.get(name, resolve));
      if (!img?.data) undecodable++;
    } else if (fn === lib.OPS.paintInlineImageXObject) {
      img = (ops.argsArray[i]?.[0] as PdfImage | undefined) ?? null;
      if (!img?.data) undecodable++;
    }
    if (img?.data && (!best || img.width * img.height > best.width * best.height)) best = img;
  }
  return { image: best, undecodable };
}
