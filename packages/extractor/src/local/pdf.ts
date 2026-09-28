import { ExtractorError } from '../extractor';
import { encodePng, grayFromPdfImage, removeRules } from './image';
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
  objs: { get(name: string, callback: (img: PdfImage) => void): void };
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

let pdfjs: Promise<PdfJs> | null = null;
const loadPdfJs = (): Promise<PdfJs> =>
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
        const image = await largestImage(lib, page);
        if (!image) {
          warnings.push(`Page ${n} has no text and no image to read.`);
          pages.push({ page: n, segments: [] });
          continue;
        }
        const lines = await ocr.recognize(encodePng(removeRules(grayFromPdfImage(image))));
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

/** The largest image painted on a page: for a scan, the page itself. */
async function largestImage(lib: PdfJs, page: PdfPage): Promise<PdfImage | null> {
  const ops = await page.getOperatorList();
  let best: PdfImage | null = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    let img: PdfImage | null = null;
    if (fn === lib.OPS.paintImageXObject) {
      const name = ops.argsArray[i]?.[0];
      if (typeof name === 'string')
        img = await new Promise<PdfImage>((resolve) => page.objs.get(name, resolve));
    } else if (fn === lib.OPS.paintInlineImageXObject) {
      img = (ops.argsArray[i]?.[0] as PdfImage | undefined) ?? null;
    }
    if (img?.data && (!best || img.width * img.height > best.width * best.height)) best = img;
  }
  return best;
}
