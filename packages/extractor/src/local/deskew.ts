import type { Gray } from './image';

/**
 * Straightening a slightly tilted page (a scan fed in at an angle, a phone photo taken askew).
 * OCR reads a line of text as a line only when it runs level: tilted by even 2°, a line breaks
 * into pieces at different heights and labels no longer sit beside their values.
 *
 * The tilt is the angle at which the page's ink, summed along nearly-horizontal lines, is most
 * sharply banded (text lines and the gaps between them). Only small tilts are corrected; turning
 * a page sideways or upside down is orientation's job. Nothing is read or guessed here.
 */

/** The largest tilt corrected, in degrees. */
const MAX_DEG = 8;
/** Below this the page is left as it is: OCR reads a line tilted by less than a degree itself. */
const MIN_DEG = 1;
const WORK_SIDE = 1200;

/** Ink points of a reduced copy of the page (dark pixels, sampled). */
function inkPoints(img: Gray): { xs: Int32Array; ys: Int32Array; h: number; w: number } {
  const k = Math.max(1, Math.ceil(Math.max(img.width, img.height) / WORK_SIDE));
  const w = Math.floor(img.width / k);
  const h = Math.floor(img.height / k);
  let sum = 0;
  const small = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = img.data[y * k * img.width + x * k] ?? 255;
      small[y * w + x] = v;
      sum += v;
    }
  const t = Math.min(160, (sum / Math.max(1, w * h)) * 0.7);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if ((small[y * w + x] ?? 255) < t) {
        xs.push(x);
        ys.push(y);
      }
  return { xs: Int32Array.from(xs), ys: Int32Array.from(ys), h, w };
}

/** How sharply banded the ink is when lines are taken at this angle (sum of squared row counts). */
function banding(p: ReturnType<typeof inkPoints>, deg: number): number {
  const tan = Math.tan((deg * Math.PI) / 180);
  const pad = Math.ceil(Math.abs(tan) * p.w) + 1;
  const rows = new Float64Array(p.h + 2 * pad);
  for (let i = 0; i < p.xs.length; i++) {
    const r = Math.round((p.ys[i] ?? 0) - (p.xs[i] ?? 0) * tan) + pad;
    if (r >= 0 && r < rows.length) rows[r] = (rows[r] ?? 0) + 1;
  }
  let s = 0;
  for (const c of rows) s += c * c;
  return s;
}

/** The page's tilt in degrees (positive: lines run down to the right); 0 when level or unclear. */
export function detectSkew(img: Gray): number {
  const p = inkPoints(img);
  if (p.xs.length < 500) return 0;
  const best = (from: number, to: number, step: number) => {
    let at = 0;
    let top = -1;
    for (let d = from; d <= to + 1e-9; d += step) {
      const b = banding(p, d);
      if (b > top) {
        top = b;
        at = d;
      }
    }
    return { at, top };
  };
  const coarse = best(-MAX_DEG, MAX_DEG, 0.5);
  const fine = best(coarse.at - 0.5, coarse.at + 0.5, 0.05);
  // A clear optimum only: level must band noticeably worse than the tilt found.
  if (Math.abs(fine.at) < MIN_DEG || banding(p, 0) > fine.top * 0.97) return 0;
  return Math.round(fine.at * 100) / 100;
}

/** The page turned by -deg about its centre, so lines tilted by deg run level; new corners white. */
export function rotateSmall(img: Gray, deg: number): Gray {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const { width: w, height: h } = img;
  const cx = w / 2;
  const cy = h / 2;
  const out = new Uint8Array(w * h).fill(255);
  // Bilinear: each output pixel blends the four input pixels around where it comes from, so the
  // edges of letters stay smooth (a nearest-pixel copy makes them jagged and OCR reads worse).
  const at = (x: number, y: number) =>
    x >= 0 && x < w && y >= 0 && y < h ? (img.data[y * w + x] ?? 255) : 255;
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const xf = cx + dx * cos - dy * sin;
      const yf = cy + dx * sin + dy * cos;
      const x0 = Math.floor(xf);
      const y0 = Math.floor(yf);
      if (x0 < -1 || x0 >= w || y0 < -1 || y0 >= h) continue;
      const fx = xf - x0;
      const fy = yf - y0;
      const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
      const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      out[y * w + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return { width: w, height: h, data: out };
}

/** The page straightened when it is tilted, with the tilt corrected (0 when it was level). */
export function straighten(img: Gray): { image: Gray; skewDeg: number } {
  const skewDeg = detectSkew(img);
  return skewDeg === 0 ? { image: img, skewDeg } : { image: rotateSmall(img, skewDeg), skewDeg };
}

/** The warning recorded when a page was straightened before reading. */
export function skewNote(page: number, deg: number): string {
  return `Page ${page} was straightened before reading (it was tilted ${Math.abs(deg).toFixed(1)}°).`;
}
