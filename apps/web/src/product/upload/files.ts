import { MAX_UPLOAD_BYTES } from '@veyra/shared';

/** What the server reads: PDFs (text or scanned) and JPEG or PNG images (photos, screenshots). */
export const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg,.txt,.json,text/plain,application/json';
const TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const EXTENSIONS = /\.(pdf|png|jpe?g)$/i;

/** An ERP goods-receipt export (JSON, often saved as .txt): imported, then its invoice checked. */
export const isReceiptExport = (file: { name: string; type: string }): boolean =>
  /\.(txt|json)$/i.test(file.name) ||
  file.type === 'application/json' ||
  file.type === 'text/plain';

export interface FileLike {
  name: string;
  type: string;
  size: number;
}

/**
 * Why a file cannot be sent, in plain words, or null. Only a quick courtesy check: the server
 * checks every file again (its real type and size) and decides.
 */
export function refusalOf(file: FileLike, maxBytes = MAX_UPLOAD_BYTES): string | null {
  if (!TYPES.has(file.type) && !EXTENSIONS.test(file.name) && !isReceiptExport(file))
    return 'Only PDF, JPEG or PNG invoices, or an ERP receipt file, can be read.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > maxBytes)
    return `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`;
  return null;
}

/** A pasted image has no meaningful name ("image.png"): give it one people recognise. */
export function pastedName(type: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
  return `Pasted invoice ${stamp}.${type === 'image/jpeg' ? 'jpg' : type === 'application/pdf' ? 'pdf' : 'png'}`;
}

/** True when a drag carries files (not text or a link being dragged around the page). */
export function carriesFiles(types: readonly string[] | DOMStringList | undefined): boolean {
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes('Files');
}
