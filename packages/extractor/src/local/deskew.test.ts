import { describe, expect, it } from 'vitest';
import type { Gray } from './image';
import { detectSkew, rotateSmall, straighten } from './deskew';

/** A level page of text-like lines: dark bands of words with gaps, as printed text bands. */
function page(): Gray {
  const width = 1200;
  const height = 1600;
  const data = new Uint8Array(width * height).fill(255);
  for (let top = 100; top < height - 100; top += 40)
    for (let y = top; y < top + 14; y++)
      for (let x = 100; x < width - 100; x++) if ((x >> 4) % 5 !== 0) data[y * width + x] = 20;
  return { width, height, data };
}

describe('straightening a tilted page', () => {
  it('a level page is left as it is', () => {
    expect(detectSkew(page())).toBe(0);
    expect(straighten(page()).skewDeg).toBe(0);
  });

  it.each([2.5, -2.5, 1.2, -4])('finds a tilt of %s° and levels it', (deg) => {
    // rotateSmall(img, -deg) turns a level page so its lines run at deg.
    const tilted = rotateSmall(page(), -deg);
    const found = detectSkew(tilted);
    expect(Math.abs(found - deg)).toBeLessThan(0.2);
    expect(Math.abs(detectSkew(straighten(tilted).image))).toBeLessThan(1);
  });

  it('a tilt under a degree is left to OCR', () => {
    expect(detectSkew(rotateSmall(page(), -0.6))).toBe(0);
  });

  it('a blank page is not turned', () => {
    const blank: Gray = { width: 800, height: 1000, data: new Uint8Array(800 * 1000).fill(255) };
    expect(detectSkew(blank)).toBe(0);
  });
});
