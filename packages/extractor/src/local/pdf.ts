import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { ExtractorError } from '../extractor';
import {
  OCR_TARGET_DPI,
  downscale,
  encodePng,
  grayFromPdfImage,
  ocrScaleFactor,
  removeRules,
} from './image';
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
  render(o: { canvas: unknown; canvasContext: unknown; viewport: unknown }): {
    promise: Promise<void>;
  };
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

/** pdf.js's metrics for the 14 standard fonts, so a page that uses them renders its text. */
const PDFJS_FONTS_DIR: string = join(PDFJS_WASM_DIR, '..', 'standard_fonts') + sep;
const PDFJS_CMAPS_DIR: string = join(PDFJS_WASM_DIR, '..', 'cmaps') + sep;

/** The canvas pdf.js draws a page on (server side). Loaded on first use. */
interface Canvas {
  width: number;
  height: number;
  getContext(kind: '2d'): {
    getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  };
  toBuffer(mime: 'image/png' | 'image/jpeg', quality?: number): Buffer;
}
let canvasLib: Promise<{ createCanvas(w: number, h: number): Canvas }> | null = null;
const loadCanvas = () =>
  (canvasLib ??= import('@napi-rs/canvas') as unknown as Promise<{
    createCanvas(w: number, h: number): Canvas;
  }>);

/** Whether pages can be rendered as images here (checked at start-up, like the decoders). */
export async function pageRenderingAvailable(): Promise<boolean> {
  try {
    (await loadCanvas()).createCanvas(1, 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Draws one whole page as an image, exactly as a viewer shows it: text, vector drawings and every
 * image on it, however the PDF stores them (strips, tiles, masks). The size is capped by the
 * decoded-image limit, so a huge page is drawn at a lower resolution, never refused.
 */
async function renderPage(page: PdfPage, dpi: number): Promise<Canvas> {
  const { width, height } = page.getViewport({ scale: 1 });
  const wanted = dpi / 72;
  const cap = Math.sqrt(LIMITS.maxImagePixels / Math.max(1, width * height));
  const scale = Math.min(wanted, cap);
  const viewport = page.getViewport({ scale });
  const canvas = (await loadCanvas()).createCanvas(
    Math.max(1, Math.ceil(viewport.width)),
    Math.max(1, Math.ceil(viewport.height)),
  );
  const context = canvas.getContext('2d');
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas;
}

/** pdf.js, set up for untrusted documents. */
async function openPdf(bytes: Uint8Array): Promise<{
  doc: PdfDocument;
  lib: PdfJs;
  close: () => Promise<void>;
}> {
  const lib = await loadPdfJs();
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
    standardFontDataUrl: PDFJS_FONTS_DIR,
    cMapUrl: PDFJS_CMAPS_DIR,
    cMapPacked: true,
    verbosity: 0,
  });
  try {
    return { doc: await task.promise, lib, close: () => task.destroy() };
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
}

/** Characters of real text on a page (its text layer), whitespace ignored. */
async function textRunsOf(page: PdfPage, n: number) {
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
  return { runs, hasText: chars >= LIMITS.minTextCharsPerPage };
}

/** How a PDF was read, page by page (logged by the API; never document content). */
export interface PdfReadDiagnostics {
  pages: number;
  /** Pages read from their text layer. */
  textPages: number;
  /** Pages read by OCR of their embedded scan image. */
  scanImagePages: number;
  /** Pages drawn as a whole-page image and read by OCR (no usable text layer or scan image). */
  renderedPages: number;
}

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
): Promise<{ pages: PageText[]; warnings: string[]; diagnostics: PdfReadDiagnostics }> {
  const { doc, lib, close } = await openPdf(bytes);
  try {
    if (doc.numPages > LIMITS.maxPdfPages)
      throw new ExtractorError(
        'DOCUMENT_TOO_LARGE',
        `The PDF has ${doc.numPages} pages. Invoices up to ${LIMITS.maxPdfPages} pages are read.`,
      );
    const pages: PageText[] = [];
    const warnings: string[] = [];
    const diagnostics: PdfReadDiagnostics = {
      pages: doc.numPages,
      textPages: 0,
      scanImagePages: 0,
      renderedPages: 0,
    };
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const { runs, hasText } = await textRunsOf(page, n);
        if (hasText) {
          pages.push({ page: n, segments: textRunsToSegments(runs) });
          diagnostics.textPages++;
          continue;
        }
        // No usable text layer: the page is read as an image. A scan stored as one page-sized
        // image is OCR'd from that image (its own resolution); anything else (strips, tiles,
        // vector-drawn text, fonts without text) is drawn as a whole page and OCR'd.
        const { width: pageWidthPt, height: pageHeightPt } = page.getViewport({ scale: 1 });
        const { image } = await largestImage(lib, page);
        const dpi = image && pageWidthPt > 0 ? image.width / (pageWidthPt / 72) : NaN;
        const coversPage =
          image !== null && Number.isFinite(dpi) && (image.height / dpi) * 72 >= pageHeightPt * 0.9;
        if (image && coversPage) {
          const lines = await ocr.recognize(
            encodePng(removeRules(downscale(grayFromPdfImage(image), ocrScaleFactor(dpi)))),
          );
          const segments = wordsToSegments(lines, n);
          if (segments.length > 0) {
            pages.push({ page: n, segments });
            diagnostics.scanImagePages++;
            warnings.push(`Page ${n} is a scan: read by OCR.`);
            continue;
          }
        }
        let canvas: Canvas;
        try {
          canvas = await renderPage(page, OCR_TARGET_DPI);
        } catch {
          warnings.push(`Page ${n} could not be drawn as an image to be read.`);
          pages.push({ page: n, segments: [] });
          continue;
        }
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const gray = grayFromPdfImage({
          width: canvas.width,
          height: canvas.height,
          kind: 3,
          data: pixels,
        });
        const lines = await ocr.recognize(encodePng(removeRules(gray)));
        pages.push({ page: n, segments: wordsToSegments(lines, n) });
        diagnostics.renderedPages++;
        warnings.push(`Page ${n} has no readable text layer: read as an image by OCR.`);
      } finally {
        page.cleanup();
      }
    }
    return { pages, warnings, diagnostics };
  } catch (error) {
    if (error instanceof ExtractorError) throw error;
    throw new ExtractorError(
      'MALFORMED_DOCUMENT',
      `The PDF could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await close();
  }
}

/** One page prepared for a visual reader: its size in PDF points, and its image if rendered. */
export interface VisionPage {
  page: number;
  widthPt: number;
  heightPt: number;
  hasText: boolean;
  /** The whole page as a JPEG, when the document needs to be read visually. */
  jpeg: Buffer | null;
}

/**
 * Prepares a PDF for a visual reader (the AI reader). When EVERY page has a real text layer the
 * PDF itself is sent (`render: false`); when any page has none (a scan, a photo in a PDF, vector
 * text), every page is drawn as an image, so the reader sees each page exactly as a person does,
 * in order, and never depends on how the PDF stores it.
 */
export async function pdfPagesForVision(
  bytes: Uint8Array,
  dpi = 200,
): Promise<{ pages: VisionPage[]; rendered: boolean }> {
  const { doc, close } = await openPdf(bytes);
  try {
    if (doc.numPages > LIMITS.maxPdfPages)
      throw new ExtractorError(
        'DOCUMENT_TOO_LARGE',
        `The PDF has ${doc.numPages} pages. Invoices up to ${LIMITS.maxPdfPages} pages are read.`,
      );
    const pages: VisionPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const { width, height } = page.getViewport({ scale: 1 });
        const { hasText } = await textRunsOf(page, n);
        pages.push({ page: n, widthPt: width, heightPt: height, hasText, jpeg: null });
      } finally {
        page.cleanup();
      }
    }
    const rendered = pages.some((p) => !p.hasText);
    if (rendered)
      for (const p of pages) {
        const page = await doc.getPage(p.page);
        try {
          p.jpeg = (await renderPage(page, dpi)).toBuffer('image/jpeg', 90);
        } finally {
          page.cleanup();
        }
      }
    return { pages, rendered };
  } finally {
    await close();
  }
}

/** One page of a PDF as a PNG, for showing the original document (never for reading it). */
export async function renderPdfPagePng(
  bytes: Uint8Array,
  pageNo: number,
  dpi = 150,
): Promise<{ png: Buffer; pages: number } | null> {
  const { doc, close } = await openPdf(bytes);
  try {
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > doc.numPages) return null;
    const page = await doc.getPage(pageNo);
    try {
      return { png: (await renderPage(page, dpi)).toBuffer('image/png'), pages: doc.numPages };
    } finally {
      page.cleanup();
    }
  } finally {
    await close();
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
