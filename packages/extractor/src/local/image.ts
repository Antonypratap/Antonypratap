import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { ExtractorError } from '../extractor';
import { LIMITS } from './limits';

/**
 * Image handling for OCR. Everything here works on untrusted bytes: dimensions are read from the
 * header and checked BEFORE any pixel is decoded, and decoders run with memory limits.
 */

export interface Gray {
  width: number;
  height: number;
  /** One byte per pixel, 0 = black, 255 = white. */
  data: Uint8Array;
}

/** Width and height from a PNG (IHDR) or JPEG (SOFn) header, or null if the header is unreadable. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[12] === 0x49) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        at += 2;
        continue;
      }
      const length = view.getUint16(at + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
      }
      if (length < 2) return null;
      at += 2 + length;
    }
  }
  return null;
}

/** Refuses images too large to OCR safely (checked from the header, before decoding). */
export function checkImageSize(size: { width: number; height: number } | null): void {
  if (!size || size.width < 1 || size.height < 1)
    throw new ExtractorError('MALFORMED_DOCUMENT', 'The image could not be read.');
  if (
    size.width > LIMITS.maxImageSide ||
    size.height > LIMITS.maxImageSide ||
    size.width * size.height > LIMITS.maxImagePixels
  ) {
    throw new ExtractorError(
      'DOCUMENT_TOO_LARGE',
      `The image is ${size.width}×${size.height} pixels. Images up to ${LIMITS.maxImageSide} pixels a side and ${LIMITS.maxImagePixels / 1_000_000} megapixels are read.`,
    );
  }
}

const luma = (r: number, g: number, b: number): number => (r * 299 + g * 587 + b * 114) / 1000;

/** Decodes a PNG or JPEG to greyscale. Size is checked first. */
export function decodeImage(bytes: Uint8Array, mime: string): Gray {
  checkImageSize(imageSize(bytes));
  let rgba: { width: number; height: number; data: Uint8Array };
  try {
    rgba =
      mime === 'image/png'
        ? PNG.sync.read(Buffer.from(bytes))
        : jpeg.decode(bytes, {
            useTArray: true,
            formatAsRGBA: true,
            maxResolutionInMP: LIMITS.maxImagePixels / 1_000_000,
            maxMemoryUsageInMB: 512,
          });
  } catch {
    throw new ExtractorError('MALFORMED_DOCUMENT', 'The image could not be decoded.');
  }
  const { width, height } = rgba;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const alpha = (rgba.data[i * 4 + 3] ?? 255) / 255;
    const v = luma(rgba.data[i * 4] ?? 0, rgba.data[i * 4 + 1] ?? 0, rgba.data[i * 4 + 2] ?? 0);
    data[i] = Math.round(v * alpha + 255 * (1 - alpha));
  }
  return { width, height, data };
}

/** pdf.js image kinds: 1 = 1 bit greyscale, 2 = RGB 24 bit, 3 = RGBA 32 bit. */
export function grayFromPdfImage(img: {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}): Gray {
  checkImageSize(img);
  const { width, height, kind, data: src } = img;
  const data = new Uint8Array(width * height);
  if (kind === 1) {
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bit = ((src[y * rowBytes + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        data[y * width + x] = bit ? 255 : 0;
      }
  } else if (kind === 2 || kind === 3) {
    const step = kind === 2 ? 3 : 4;
    for (let i = 0; i < width * height; i++)
      data[i] = luma(src[i * step] ?? 0, src[i * step + 1] ?? 0, src[i * step + 2] ?? 0);
  } else {
    throw new ExtractorError('MALFORMED_DOCUMENT', 'A page image has an unsupported format.');
  }
  return { width, height, data };
}

/**
 * Removes table rules (long straight dark lines) so they do not merge with the text they frame.
 * Deterministic, and it only ever turns line pixels white: it never adds or moves ink.
 */
export function removeRules(img: Gray): Gray {
  const { width: W, height: H } = img;
  const out = Uint8Array.from(img.data);
  const dark = (v: number) => v < 140;
  const minH = Math.max(40, Math.round(W * 0.06));
  const minV = Math.max(30, Math.round(H * 0.02));
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x <= W; x++) {
      if (x < W && dark(img.data[y * W + x] ?? 255)) run++;
      else {
        if (run >= minH) out.fill(255, y * W + x - run, y * W + x);
        run = 0;
      }
    }
  }
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = 0; y <= H; y++) {
      if (y < H && dark(img.data[y * W + x] ?? 255)) run++;
      else {
        if (run >= minV) for (let k = y - run; k < y; k++) out[k * W + x] = 255;
        run = 0;
      }
    }
  }
  return { width: W, height: H, data: out };
}

/**
 * Greyscale PNG, the format handed to the OCR engine. Lossless: the engine gets exactly these
 * pixels. Written straight from the greyscale bytes with no row filter (Phase 7): about ten
 * times faster than the adaptive filters, for the same pixels (the PNG is a little larger, and
 * never leaves the process).
 */
export function encodePng(img: Gray): Uint8Array {
  return PNG.sync.write(
    {
      width: img.width,
      height: img.height,
      data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    } as PNG,
    { colorType: 0, inputColorType: 0, filterType: 0 },
  );
}
