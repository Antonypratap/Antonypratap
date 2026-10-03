import type { Gray } from './image';

/**
 * Page orientation: a scanner or phone often stores an invoice sideways or upside down, and a
 * reader (the AI or OCR) then reads fragments. Veyrafy turns each page image upright before it is
 * read, and the viewer shows the same upright page, so evidence boxes line up.
 *
 * Detection is deterministic and uses only the page's own pixels, so the reader and the viewer
 * reach the same answer independently, with nothing stored:
 *
 *  1. Which way do the text lines run? Lines of text make the ink profile across them jump
 *     between line and gap; along them it is smooth. Compared on the image as is and turned 90°.
 *  2. Which way is up? In Latin print more ink sits above a line's core (ascenders, capitals,
 *     digits) than below it (descenders), and the left edges of lines align more than the right.
 *
 * It only turns a page when the evidence is clear; otherwise the page is left as it is. It never
 * changes a pixel otherwise.
 */
export type Rotation = 0 | 90 | 180 | 270;

/** Long side the page is reduced to for detection (enough for line structure; fast). */
const WORK_SIDE = 1000;
/**
 * How clearly a page must look upside down before it is turned (measured on the synthetic
 * fixtures: upright pages score 0.19 to 0.83, upside-down ones -0.58 to -0.92).
 */
const UPSIDE_DOWN_EVIDENCE = 0.3;

/** Rotates a greyscale image clockwise by `deg`. */
export function rotateGray(img: Gray, deg: Rotation): Gray {
  if (deg === 0) return img;
  const { width: W, height: H, data } = img;
  const turned = deg === 90 || deg === 270;
  const w = turned ? H : W;
  const h = turned ? W : H;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = data[y * W + x] ?? 255;
      let nx: number;
      let ny: number;
      if (deg === 90) {
        nx = H - 1 - y;
        ny = x;
      } else if (deg === 180) {
        nx = W - 1 - x;
        ny = H - 1 - y;
      } else {
        nx = y;
        ny = W - 1 - x;
      }
      out[ny * w + nx] = v;
    }
  return { width: w, height: h, data: out };
}

/** A small black-and-white working copy: ink = 1. Long ruled lines are removed (tables). */
function inkMap(img: Gray): { w: number; h: number; ink: Uint8Array } {
  const k = Math.max(1, Math.ceil(Math.max(img.width, img.height) / WORK_SIDE));
  const w = Math.floor(img.width / k);
  const h = Math.floor(img.height / k);
  const ink = new Uint8Array(w * h);
  let sum = 0;
  const small = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) s += img.data[(y * k + dy) * img.width + x * k + dx] ?? 255;
      const v = s / (k * k);
      small[y * w + x] = v;
      sum += v;
    }
  // Threshold between the page's mean and black: robust to grey paper and faint print.
  const t = Math.min(170, (sum / Math.max(1, w * h)) * 0.75);
  for (let i = 0; i < w * h; i++) ink[i] = (small[i] ?? 255) < t ? 1 : 0;
  // Ruled lines (table borders, underlines) are not text: drop long straight runs of ink.
  const clear = (horizontal: boolean) => {
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    const limit = Math.max(40, inner * 0.12);
    for (let o = 0; o < outer; o++) {
      let start = -1;
      for (let i = 0; i <= inner; i++) {
        const idx = horizontal ? o * w + i : i * w + o;
        const on = i < inner && ink[idx] === 1;
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          if (i - start > limit)
            for (let j = start; j < i; j++) ink[horizontal ? o * w + j : j * w + o] = 0;
          start = -1;
        }
      }
    }
  };
  clear(true);
  clear(false);
  return { w, h, ink };
}

/**
 * Which way the text runs, voted tile by tile: inside a small patch of text, the ink profile
 * across the lines is peaky (line, gap, line), while along the lines it is even. Whole-page
 * profiles are fooled by table columns; small tiles are not. > 0: lines run along the rows.
 */
function lineVote(m: { w: number; h: number; ink: Uint8Array }): number {
  const T = Math.max(48, Math.round(Math.min(m.w, m.h) / 8));
  let vote = 0;
  let weight = 0;
  const peaky = (p: Float64Array) => {
    let s = 0;
    let s2 = 0;
    for (const v of p) {
      s += v;
      s2 += v * v;
    }
    const n = p.length;
    const mean = s / n;
    return mean > 0 ? s2 / n / (mean * mean) - 1 : 0;
  };
  for (let ty = 0; ty + T <= m.h; ty += T)
    for (let tx = 0; tx + T <= m.w; tx += T) {
      const rows = new Float64Array(T);
      const cols = new Float64Array(T);
      let ink = 0;
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++)
          if (m.ink[(ty + y) * m.w + tx + x]) {
            rows[y] = (rows[y] ?? 0) + 1;
            cols[x] = (cols[x] ?? 0) + 1;
            ink++;
          }
      const fill = ink / (T * T);
      if (fill < 0.01 || fill > 0.45) continue;
      const r = peaky(rows);
      const c = peaky(cols);
      if (r + c <= 0) continue;
      vote += Math.log((r + 0.05) / (c + 0.05)) * ink;
      weight += ink;
    }
  return weight > 0 ? vote / weight : 0;
}

function profiles(m: { w: number; h: number; ink: Uint8Array }) {
  const rows = new Float64Array(m.h);
  const cols = new Float64Array(m.w);
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++)
      if (m.ink[y * m.w + x]) {
        rows[y] = (rows[y] ?? 0) + 1;
        cols[x] = (cols[x] ?? 0) + 1;
      }
  return { rows, cols };
}

/**
 * Evidence that rows-as-lines are the right way up (> 0) or upside down (< 0), on a map whose
 * text lines run along the rows.
 */
function uprightness(m: { w: number; h: number; ink: Uint8Array }): number {
  const { rows } = profiles(m);
  const max = rows.reduce((a, b) => Math.max(a, b), 0);
  if (max === 0) return 0;
  let above = 0;
  let below = 0;
  const lefts: number[] = [];
  const rights: number[] = [];
  let y = 0;
  while (y < m.h) {
    if ((rows[y] ?? 0) <= max * 0.04) {
      y++;
      continue;
    }
    const a = y;
    while (y < m.h && (rows[y] ?? 0) > max * 0.04) y++;
    const b = y - 1;
    if (b - a < 3) continue;
    let peak = 0;
    for (let i = a; i <= b; i++) peak = Math.max(peak, rows[i] ?? 0);
    let ct = a;
    while (ct <= b && (rows[ct] ?? 0) < peak * 0.5) ct++;
    let cb = b;
    while (cb >= a && (rows[cb] ?? 0) < peak * 0.5) cb--;
    for (let i = a; i < ct; i++) above += rows[i] ?? 0;
    for (let i = cb + 1; i <= b; i++) below += rows[i] ?? 0;
    // The line's left and right ink edges.
    let l = m.w;
    let r = -1;
    for (let i = a; i <= b; i++)
      for (let x = 0; x < m.w; x++)
        if (m.ink[i * m.w + x]) {
          if (x < l) l = x;
          if (x > r) r = x;
        }
    if (r >= 0) {
      lefts.push(l);
      rights.push(r);
    }
  }
  // Alignment: how many lines share their left edge vs their right edge (within 1% of width).
  const shared = (xs: number[]) => {
    const tol = Math.max(2, m.w * 0.01);
    let best = 0;
    for (const x of xs) best = Math.max(best, xs.filter((v) => Math.abs(v - x) <= tol).length);
    return xs.length ? best / xs.length : 0;
  };
  const leftSpread = shared(lefts);
  const rightSpread = shared(rights);
  const asc = above + below > 0 ? (above - below) / (above + below) : 0;
  return asc + (leftSpread - rightSpread) * 0.5;
}

export interface OrientationReading {
  rotation: Rotation;
  /** How the decision was reached, for tests and diagnostics. */
  lineRatio: number;
  upright: number;
}

/** Clockwise rotation that makes the page upright; 0 when upright or unclear. */
export function detectOrientation(img: Gray): OrientationReading {
  const m = inkMap(img);
  const inkCount = m.ink.reduce((a, b) => a + b, 0);
  // Too little ink to judge (a blank or nearly blank page): leave it.
  if (inkCount < m.w * m.h * 0.002) return { rotation: 0, lineRatio: 0, upright: 0 };
  // lineRatio > 0: lines run along the rows (upright or upside down); < 0: sideways.
  const lineRatio = lineVote(m);
  if (Math.abs(lineRatio) < 0.15) return { rotation: 0, lineRatio, upright: 0 };
  const sideways = lineRatio < 0;
  // Look at the page with its lines running along the rows.
  const base: Rotation = sideways ? 90 : 0;
  const view = base === 0 ? m : inkMapRotated(m, 90);
  const upright = uprightness(view);
  let rotation: Rotation;
  if (sideways)
    // The lines clearly run the wrong way: turning is always better than leaving it; the sign
    // decides which way (a wrong guess there is no worse than sideways).
    rotation = upright < 0 ? 270 : 90;
  else
    // Upside down needs strong evidence: an upright page wrongly flipped would break an invoice
    // that reads fine today.
    rotation = upright <= -UPSIDE_DOWN_EVIDENCE ? 180 : 0;
  return { rotation, lineRatio, upright };
}

export function detectRotation(img: Gray): Rotation {
  return detectOrientation(img).rotation;
}

function inkMapRotated(m: { w: number; h: number; ink: Uint8Array }, deg: Rotation) {
  const g = rotateGray({ width: m.w, height: m.h, data: m.ink }, deg);
  return { w: g.width, h: g.height, ink: g.data };
}

/** The warning recorded when a page was turned upright before reading. */
export function rotationNote(page: number, rotation: Rotation): string {
  return `Page ${page} was turned upright before reading (it was stored ${rotation === 180 ? 'upside down' : 'sideways'}).`;
}

/** Turns a greyscale page upright (the local OCR path). */
export function uprightGray(img: Gray): { image: Gray; rotation: Rotation } {
  const rotation = detectRotation(img);
  return { image: rotateGray(img, rotation), rotation };
}

// ── Drawn pages and photos (the AI reader and the viewer) ─────────────────────

interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): unknown;
  toBuffer(mime: 'image/png' | 'image/jpeg', quality?: number): Buffer;
}
interface Ctx2d {
  drawImage(img: unknown, x: number, y: number, w?: number, h?: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  translate(x: number, y: number): void;
  rotate(rad: number): void;
}
interface CanvasLib {
  createCanvas(w: number, h: number): CanvasLike;
  loadImage(src: Buffer): Promise<{ width: number; height: number }>;
}
let canvasLib: Promise<CanvasLib> | null = null;
const loadCanvas = () => (canvasLib ??= import('@napi-rs/canvas') as unknown as Promise<CanvasLib>);

/**
 * The page's orientation, judged on a copy scaled to a fixed size, so the reader (drawn at one
 * resolution) and the viewer (drawn at another) always reach the same answer.
 */
async function rotationOf(lib: CanvasLib, src: unknown, width: number, height: number) {
  const k = WORK_SIDE / Math.max(width, height);
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const small = lib.createCanvas(w, h);
  const ctx = small.getContext('2d') as Ctx2d;
  ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    data[i] =
      ((px[i * 4] ?? 255) * 299 + (px[i * 4 + 1] ?? 255) * 587 + (px[i * 4 + 2] ?? 255) * 114) /
      1000;
  return detectRotation({ width: w, height: h, data });
}

async function turned(lib: CanvasLib, src: unknown, width: number, height: number, deg: Rotation) {
  const side = deg === 90 || deg === 270;
  const out = lib.createCanvas(side ? height : width, side ? width : height);
  const ctx = out.getContext('2d') as Ctx2d;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -width / 2, -height / 2);
  return out;
}

/** A drawn page (a PDF page rendered to a canvas), turned upright. */
export async function uprightCanvas<C extends CanvasLike>(
  canvas: C,
): Promise<{ canvas: C | CanvasLike; rotation: Rotation }> {
  const lib = await loadCanvas();
  const rotation = await rotationOf(lib, canvas, canvas.width, canvas.height);
  if (rotation === 0) return { canvas, rotation };
  return { canvas: await turned(lib, canvas, canvas.width, canvas.height, rotation), rotation };
}

/**
 * A photo (PNG or JPEG), turned upright: the same bytes when it already is, otherwise the turned
 * image in the same format. Width and height are the upright image's.
 */
export async function uprightImage(
  bytes: Buffer,
  mime: 'image/png' | 'image/jpeg',
): Promise<{ bytes: Buffer; rotation: Rotation; width: number; height: number }> {
  const lib = await loadCanvas();
  const img = await lib.loadImage(bytes);
  const rotation = await rotationOf(lib, img, img.width, img.height);
  if (rotation === 0) return { bytes, rotation, width: img.width, height: img.height };
  const out = await turned(lib, img, img.width, img.height, rotation);
  return {
    bytes: mime === 'image/png' ? out.toBuffer('image/png') : out.toBuffer('image/jpeg', 92),
    rotation,
    width: out.width,
    height: out.height,
  };
}
