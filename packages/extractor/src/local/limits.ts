/**
 * Defensive limits for untrusted documents (Phase 3D). Upload size (20 MB) is enforced by the API
 * before a document is stored; these apply while reading it.
 */
const DEFAULTS = {
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
};

export type DocumentLimits = typeof DEFAULTS;

/** The limits in force. Read-only outside this module; see `configureDocumentLimits`. */
export const LIMITS: Readonly<DocumentLimits> = { ...DEFAULTS };

/** The limits a deployment may tighten (Phase 6). */
export type ConfigurableDocumentLimits = Pick<
  DocumentLimits,
  'maxPdfPages' | 'maxImageSide' | 'maxImagePixels'
>;

/**
 * Sets the deployment's document limits at startup (Phase 6). Limits can only be lowered: a value
 * above the built-in default is refused, so configuration can never widen what Veyra reads.
 */
export function configureDocumentLimits(limits: Partial<ConfigurableDocumentLimits>): void {
  const next = { ...DEFAULTS };
  for (const key of ['maxPdfPages', 'maxImageSide', 'maxImagePixels'] as const) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > DEFAULTS[key])
      throw new RangeError(`${key} must be a whole number from 1 to ${DEFAULTS[key]}`);
    next[key] = value;
  }
  Object.assign(LIMITS, next);
}
