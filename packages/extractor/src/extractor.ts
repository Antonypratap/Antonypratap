import { readFile } from 'node:fs/promises';
import type { ExtractionResult, ExtractorId } from '@veyra/shared';

/** What an extractor is given: the stored document and its identity (ARCHITECTURE §3.1). */
export interface ExtractorInput {
  documentId: string;
  /**
   * The document's bytes. Veyrafy passes them in memory (decrypted from storage), so no plaintext
   * copy of an invoice is ever written to disk to be read.
   */
  bytes?: Uint8Array;
  /** A file holding the document (tools and tests); used only when `bytes` is not given. */
  filePath?: string;
  mime: string;
  /** Lower-case hex SHA-256 of the document bytes. */
  sha256: string;
}

/**
 * The extraction port. Implementations only READ the document and propose values with evidence
 * and confidence. Their output is untrusted: the caller validates it with `ExtractionResultSchema`
 * and the deterministic core decides what, if anything, is usable. Extractors never touch the ERP.
 */
export interface Extractor {
  readonly id: ExtractorId;
  readonly version: string;
  isAvailable(): Promise<{ ok: true } | { ok: false; reason: string }>;
  extract(input: ExtractorInput): Promise<ExtractionResult>;
}

export type ExtractorErrorCode =
  | 'NOT_ALLOWED'
  | 'UNKNOWN_DOCUMENT'
  | 'UNSUPPORTED_MIME'
  /** The file is not a readable PDF/PNG/JPEG (truncated, corrupt, encrypted…). */
  | 'MALFORMED_DOCUMENT'
  /** Too many pages, or an image too large to read safely. */
  | 'DOCUMENT_TOO_LARGE'
  /** The file appears to hold more than one invoice; Veyra never merges or splits them. */
  | 'MULTIPLE_INVOICES'
  | 'OCR_UNAVAILABLE'
  | 'OCR_FAILED';

/** An extractor could not read a document. The workflow records it and moves the invoice to FAILED. */
export class ExtractorError extends Error {
  constructor(
    readonly code: ExtractorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractorError';
  }
}

/** The input document's bytes: given in memory, or read from its file. */
export async function inputBytes(input: ExtractorInput): Promise<Uint8Array> {
  if (input.bytes) return input.bytes;
  if (input.filePath) return new Uint8Array(await readFile(input.filePath));
  throw new ExtractorError('MALFORMED_DOCUMENT', 'No document was given to read.');
}
