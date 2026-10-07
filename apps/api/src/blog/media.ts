import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { BLOG_LIMITS } from '@veyra/shared';
import { VeyraError } from '../workflow/veyra';

/**
 * Blog images: an upload is accepted only if its first bytes say PNG, JPEG or WebP and it decodes
 * as an image; it is then drawn afresh and re-encoded as WebP. The stored file is therefore always
 * a plain image made by the server: metadata (camera, location) is dropped, and nothing the
 * uploader put in the file (a script, an HTML or SVG payload, a polyglot) survives. SVG, GIF and
 * everything else are refused.
 */
export interface ProcessedImage {
  mime: 'image/webp';
  body: Buffer;
  width: number;
  height: number;
  /** At most SMALL_WIDTH wide, when the image is wider than that. */
  small: { body: Buffer; width: number } | null;
  sha256: string;
}

const SMALL_WIDTH = 800;
/** Decoding a huge image costs memory: refuse anything beyond 50 megapixels. */
const MAX_PIXELS = 50_000_000;

export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'webp';
  return null;
}

async function encode(
  img: Awaited<ReturnType<typeof loadImage>>,
  width: number,
): Promise<{ body: Buffer; width: number; height: number }> {
  const w = Math.min(width, img.width);
  const h = Math.max(1, Math.round((img.height * w) / img.width));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return { body: await canvas.encode('webp', 82), width: w, height: h };
}

export async function processImage(bytes: Uint8Array): Promise<ProcessedImage> {
  if (bytes.byteLength === 0) throw new VeyraError('INVALID_INPUT', 'The file is empty.');
  if (bytes.byteLength > BLOG_LIMITS.mediaBytes)
    throw new VeyraError('INVALID_INPUT', 'Images up to 8 MB are accepted.');
  if (!sniffImage(bytes))
    throw new VeyraError('UNSUPPORTED_FILE', 'Upload a PNG, JPEG or WebP image.');
  let img: Awaited<ReturnType<typeof loadImage>>;
  try {
    img = await loadImage(Buffer.from(bytes));
  } catch {
    throw new VeyraError('UNSUPPORTED_FILE', 'This image could not be read.');
  }
  if (!img.width || !img.height || img.width * img.height > MAX_PIXELS)
    throw new VeyraError('UNSUPPORTED_FILE', 'This image is too large to use.');
  const main = await encode(img, BLOG_LIMITS.mediaWidth);
  const small = main.width > SMALL_WIDTH ? await encode(img, SMALL_WIDTH) : null;
  return {
    mime: 'image/webp',
    body: main.body,
    width: main.width,
    height: main.height,
    small: small ? { body: small.body, width: small.width } : null,
    sha256: createHash('sha256').update(main.body).digest('hex'),
  };
}
