import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeImage, encodePng, type Gray } from './image';
import { LocalDocumentExtractor } from './local-extractor';
import {
  detectOrientation,
  detectRotation,
  rotateGray,
  uprightImage,
  type Rotation,
} from './orientation';
import { pdfPagesForVision, renderPdfPagePng } from './pdf';

/** Synthetic fixtures only: no real invoice is ever used here. */
const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
const file = (name: string) => new Uint8Array(readFileSync(new URL(name, DOCS)));

const pageGray = async (name: string): Promise<Gray> => {
  if (!name.endsWith('.pdf'))
    return decodeImage(file(name), name.endsWith('.png') ? 'image/png' : 'image/jpeg');
  const r = await renderPdfPagePng(file(name), 1);
  if (!r) throw new Error(`no page: ${name}`);
  return decodeImage(new Uint8Array(r.png), 'image/png');
};

const toJpeg = (g: Gray): Buffer => {
  const rgba = Buffer.alloc(g.width * g.height * 4);
  for (let i = 0; i < g.width * g.height; i++) {
    const v = g.data[i] ?? 255;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data: rgba, width: g.width, height: g.height }, 90).data);
};

/** A one-page scanned PDF holding just this image (as a scanner stores it, no text layer). */
const scanPdf = (img: Gray): Uint8Array => {
  const jpg = toJpeg(img);
  // 150 dpi: the page in points follows the image, so a sideways image makes a sideways page.
  const w = (img.width * 72) / 150;
  const h = (img.height * 72) / 150;
  const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 0 cm /Im0 Do Q`;
  const objs: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`,
      ),
      jpg,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let at = parts[0]?.length ?? 0;
  objs.forEach((o, i) => {
    offsets.push(at);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(b);
    at += b.length;
  });
  const xref = [
    'xref',
    `0 ${objs.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    `trailer << /Size ${objs.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(at),
    '%%EOF',
  ].join('\n');
  return new Uint8Array(Buffer.concat([...parts, Buffer.from(xref)]));
};

const undo = (r: Rotation): Rotation => ((360 - r) % 360) as Rotation;

describe('page orientation: every page is read upright', () => {
  const FIXTURES = [
    'D01-clean-text.pdf',
    'D02-scanned.pdf',
    'D14-office-scan.pdf',
    'D03-photo.jpg',
    'D05-blurry.jpg',
    'brewery/B06-photo.png',
  ];

  it('finds how far a page was turned, for every fixture at every rotation', async () => {
    for (const name of FIXTURES) {
      const g = await pageGray(name);
      for (const r of [0, 90, 180, 270] as Rotation[])
        expect(detectRotation(rotateGray(g, r)), `${name} turned ${r}°`).toBe(undo(r));
    }
  }, 60_000);

  it('leaves an upright page alone, with clear evidence (never flips a page that reads fine)', async () => {
    for (const name of FIXTURES) {
      const o = detectOrientation(await pageGray(name));
      expect(o.rotation, name).toBe(0);
      expect(o.upright, name).toBeGreaterThan(-0.3);
    }
  }, 60_000);

  it('a blank page, or one with almost no ink, is left as it is', () => {
    const blank = { width: 600, height: 800, data: new Uint8Array(600 * 800).fill(255) };
    expect(detectRotation(blank)).toBe(0);
    const speck = { ...blank, data: blank.data.slice() };
    for (let i = 0; i < 40; i++) speck.data[400 * 600 + 300 + i] = 0;
    expect(detectRotation(speck)).toBe(0);
  });

  it('turning is exact and reversible', () => {
    const g = { width: 3, height: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6]) };
    expect(rotateGray(g, 90)).toEqual({
      width: 2,
      height: 3,
      data: new Uint8Array([4, 1, 5, 2, 6, 3]),
    });
    expect(rotateGray(rotateGray(g, 90), 270)).toEqual(g);
    expect(rotateGray(rotateGray(g, 180), 180)).toEqual(g);
  });

  it('is fast enough to run on every page', async () => {
    const g = rotateGray(await pageGray('D01-clean-text.pdf'), 90);
    const t0 = performance.now();
    detectRotation(g);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('a sideways photo is turned upright, in its own format, with the upright size', async () => {
    const g = await pageGray('D04-photo.png');
    const sideways = Buffer.from(encodePng(rotateGray(g, 90)));
    const up = await uprightImage(sideways, 'image/png');
    expect(up.rotation).toBe(270);
    expect({ width: up.width, height: up.height }).toEqual({ width: g.width, height: g.height });
    expect(up.bytes.subarray(1, 4).toString()).toBe('PNG');
    const same = Buffer.from(encodePng(g));
    expect((await uprightImage(same, 'image/png')).bytes).toBe(same); // untouched when upright
  });
});

describe('a sideways invoice reads like the upright one', () => {
  const extractor = new LocalDocumentExtractor();
  afterAll(() => extractor.close());
  const key = (r: Awaited<ReturnType<typeof extractor.extractBytes>>) => ({
    number: r.header.invoiceNumber.value,
    supplier: r.header.vendorName.value,
    taxable: r.header.taxablePaise.value,
    total: r.header.totalPaise.value,
  });

  it('a phone photo stored sideways', async () => {
    const g = await pageGray('D04-photo.png');
    const upright = await extractor.extractBytes(encodePng(g), 'image/png');
    const turned = await extractor.extractBytes(encodePng(rotateGray(g, 90)), 'image/png');
    expect(key(upright).number).not.toBeNull();
    expect(key(turned)).toEqual(key(upright));
    expect(turned.warnings).toContain(
      'Page 1 was turned upright before reading (it was stored sideways).',
    );
    expect(upright.warnings.join(' ')).not.toMatch(/turned upright/);
  }, 60_000);

  it('a scanned PDF stored sideways: read upright, sent upright, shown upright', async () => {
    const g = await pageGray('D02-scanned.pdf');
    const sideways = scanPdf(rotateGray(g, 270));
    const upright = await extractor.extractBytes(scanPdf(g), 'application/pdf');
    const turned = await extractor.extractBytes(sideways, 'application/pdf');
    expect(key(upright).number).not.toBeNull();
    expect(key(turned)).toEqual(key(upright));
    expect(turned.warnings.join(' ')).toMatch(/Page 1 was turned upright before reading/);

    // The AI reader is sent the upright page, with the upright page's size for evidence boxes.
    const vision = await pdfPagesForVision(sideways);
    const original = (await pdfPagesForVision(scanPdf(g))).pages[0];
    if (!original) throw new Error('no page');
    expect(vision.rendered).toBe(true);
    expect(vision.pages[0]).toMatchObject({ rotation: 90 });
    expect(vision.pages[0]?.widthPt).toBeCloseTo(original.widthPt, 0);
    expect(vision.pages[0]?.heightPt).toBeCloseTo(original.heightPt, 0);
    expect(original.rotation).toBe(0);

    // The viewer shows the same upright page.
    const shown = decodeImage(
      new Uint8Array((await renderPdfPagePng(sideways, 1))?.png ?? Buffer.alloc(0)),
      'image/png',
    );
    expect(shown.width > shown.height).toBe(g.width > g.height);
  }, 90_000);
});
