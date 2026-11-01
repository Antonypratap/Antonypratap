import { confidenceBp, type ExtractedHeader } from '@veyra/shared';
import { encodePng, type Gray } from './image';
import type { OcrEngine } from './ocr';
import { ocrGstin, parseAmount, parseDate } from './parse';

/**
 * A second, closer look at a key value OCR was not sure of. The value's spot on the page is cut
 * out, enlarged and read again on its own. The second reading is only used when it is proven:
 * a GSTIN by its check character; any other value by reading exactly the same as the first time,
 * this time with confidence. Otherwise the value stays as it was (to be confirmed). Nothing is
 * guessed, and a value is never taken from anywhere but its own spot.
 */

/** Below this a value is looked at again (the default certainty an invoice needs). */
const UNSURE_BP = 9000;
/** A second reading counts only at this confidence (0–100) or more. */
const SECOND_READ_MIN = 90;
/** A GSTIN proven by its check character (as proveByChecks gives it). */
const PROVEN_BP = 9800;
const SCALE = 3;

type Kind = 'gstin' | 'id' | 'date' | 'money';
const FIELDS: readonly [keyof ExtractedHeader, Kind, string][] = [
  ['vendorGstin', 'gstin', "supplier's GSTIN"],
  ['buyerGstin', 'gstin', "buyer's GSTIN"],
  ['shipToGstin', 'gstin', 'ship-to GSTIN'],
  ['invoiceNumber', 'id', 'invoice number'],
  ['poNumber', 'id', 'order number'],
  ['invoiceDate', 'date', 'invoice date'],
  ['taxablePaise', 'money', 'taxable value'],
  ['cgstPaise', 'money', 'CGST'],
  ['sgstPaise', 'money', 'SGST'],
  ['igstPaise', 'money', 'IGST'],
  ['totalPaise', 'money', 'invoice total'],
];

type F = {
  value: unknown;
  confidenceBp: number;
  source: string;
  evidence: { page: number; bbox: number[] } | null;
};

/** The spot (x, y, w, h) with a margin, cut out and enlarged (bilinear), on a white border. */
export function closeUp(img: Gray, bbox: readonly number[], scale = SCALE): Gray | null {
  const [bx = 0, by = 0, bw = 0, bh = 0] = bbox;
  if (bw <= 0 || bh <= 0) return null;
  const mx = bh * 1.2;
  const my = bh * 0.6;
  const x0 = Math.max(0, Math.floor(bx - mx));
  const y0 = Math.max(0, Math.floor(by - my));
  const x1 = Math.min(img.width, Math.ceil(bx + bw + mx));
  const y1 = Math.min(img.height, Math.ceil(by + bh + my));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const pad = 24;
  const W = w * scale + 2 * pad;
  const H = h * scale + 2 * pad;
  const out = new Uint8Array(W * H).fill(255);
  const at = (x: number, y: number) =>
    img.data[Math.min(y1 - 1, Math.max(y0, y)) * img.width + Math.min(x1 - 1, Math.max(x0, x))] ??
    255;
  for (let y = 0; y < h * scale; y++) {
    const sy = y0 + (y + 0.5) / scale - 0.5;
    const iy = Math.floor(sy);
    const fy = sy - iy;
    for (let x = 0; x < w * scale; x++) {
      const sx = x0 + (x + 0.5) / scale - 0.5;
      const ix = Math.floor(sx);
      const fx = sx - ix;
      const top = at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx;
      const bottom = at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx;
      out[(y + pad) * W + x + pad] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return { width: W, height: H, data: out };
}

/** The words of a second reading, each as it stands and with what follows a ":" in it. */
function tokens(words: readonly { text: string; conf: number }[]) {
  return words.flatMap((w) => {
    const t = w.text.trim().replace(/^[|[\]]+|[|[\]]+$/g, '');
    const after = t.includes(':') ? t.slice(t.lastIndexOf(':') + 1) : null;
    return [t, ...(after ? [after] : [])].filter(Boolean).map((text) => ({ text, conf: w.conf }));
  });
}

/**
 * Looks again at the key header values OCR was not sure of (OCR-read pages only). Changes a value
 * only for a GSTIN its check character proves; otherwise only raises the confidence of a value read
 * the same way twice. Returns a note naming what a second look settled, or null.
 */
export async function secondLook(
  header: ExtractedHeader,
  images: ReadonlyMap<number, Gray>,
  ocr: OcrEngine,
): Promise<string | null> {
  const settled: string[] = [];
  const h = header as unknown as Record<string, F>;
  for (const [key, kind, name] of FIELDS) {
    const f = h[key];
    if (!f || f.source !== 'tesseract' || !f.evidence || f.confidenceBp >= UNSURE_BP) continue;
    if (f.value === null && kind !== 'gstin') continue;
    const img = images.get(f.evidence.page);
    const crop = img ? closeUp(img, f.evidence.bbox) : null;
    if (!crop) continue;
    let words: { text: string; conf: number }[];
    try {
      words = (await ocr.recognize(encodePng(crop))).flatMap((l) => l.words);
    } catch {
      continue;
    }
    const toks = tokens(words);
    if (kind === 'gstin') {
      const found = new Set(
        toks.map((t) => ocrGstin(t.text)).filter((g): g is string => g !== null),
      );
      // Two runs read together ("29BBQPN1599 K1ZO"): the line without spaces too.
      const joined = words.map((w) => w.text).join('');
      for (const m of joined.matchAll(/[0-9A-Z]{15}/gi)) {
        const g = ocrGstin(m[0]);
        if (g) found.add(g);
      }
      const [only] = found;
      if (found.size === 1 && only) {
        h[key] = { ...f, value: only, confidenceBp: confidenceBp(PROVEN_BP) };
        settled.push(name);
      }
      continue;
    }
    const same = toks.filter((t) => {
      if (t.conf < SECOND_READ_MIN) return false;
      if (kind === 'id') return t.text.toUpperCase() === String(f.value).toUpperCase();
      if (kind === 'date') return parseDate(t.text) === f.value;
      return parseAmount(t.text.replace(/[!,;:'`]$/, '')) === f.value;
    });
    if (same.length) {
      const conf = Math.min(PROVEN_BP, Math.round(Math.min(...same.map((t) => t.conf)) * 100));
      if (conf > f.confidenceBp) {
        h[key] = { ...f, confidenceBp: confidenceBp(conf) };
        settled.push(name);
      }
    }
  }
  return settled.length
    ? `Looked at again more closely and confirmed: ${settled.join(', ')}.`
    : null;
}
