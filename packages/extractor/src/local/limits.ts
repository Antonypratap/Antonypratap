/**
 * Defensive limits for untrusted documents (Phase 3D). Upload size (20 MB) is enforced by the API
 * before a document is stored; these apply while reading it.
 */
export const LIMITS = {
  /** Pages read from one PDF. Longer files fail visibly instead of being partly read. */
  maxPdfPages: 20,
  /** Largest side of an image (or a page image inside a PDF), in pixels. */
  maxImageSide: 12_000,
  /** Largest image area, in pixels (checked before decoding). */
  maxImagePixels: 40_000_000,
  /** Text characters on a PDF page below which the page is treated as scanned and OCR'd. */
  minTextCharsPerPage: 40,
  /** OCR time per page before the attempt is abandoned (the invoice then fails visibly). */
  ocrTimeoutMs: 60_000,
} as const;
