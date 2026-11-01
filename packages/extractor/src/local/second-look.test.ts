import { describe, expect, it } from 'vitest';
import { confidenceBp, type ExtractedHeader } from '@veyra/shared';
import type { Gray } from './image';
import type { OcrEngine, OcrLine } from './ocr';
import { closeUp, secondLook } from './second-look';

/** An OCR engine that reads each close-up as the next scripted line (a stand-in for Tesseract). */
function scripted(...reads: { text: string; conf: number }[][]): OcrEngine & { calls: number } {
  const e = {
    name: 'scripted',
    version: '1',
    calls: 0,
    recognize: async (): Promise<OcrLine[]> => {
      const words = reads[e.calls++] ?? [];
      return [{ words: words.map((w) => ({ ...w, x0: 0, y0: 0, x1: 1, y1: 1 })) }];
    },
    close: async () => undefined,
  };
  return e;
}
const page: Gray = { width: 400, height: 200, data: new Uint8Array(400 * 200).fill(255) };
const field = (value: string | number | null, bp: number) => ({
  value,
  confidenceBp: confidenceBp(bp),
  source: 'tesseract' as const,
  // A value not found at all has no place on the page.
  evidence: value === null ? null : { page: 1, text: String(value), bbox: [20, 20, 200, 16] },
});
const header = (over: Record<string, unknown>) =>
  ({
    vendorGstin: field(null, 0),
    buyerGstin: field(null, 0),
    shipToGstin: field(null, 0),
    invoiceNumber: field(null, 0),
    poNumber: field(null, 0),
    invoiceDate: field(null, 0),
    taxablePaise: field(null, 0),
    cgstPaise: field(null, 0),
    sgstPaise: field(null, 0),
    igstPaise: field(null, 0),
    totalPaise: field(null, 0),
    ...over,
  }) as unknown as ExtractedHeader;
const images = new Map([[1, page]]);

describe('a second, closer look at a value OCR was unsure of', () => {
  it('cuts the spot out enlarged, on a white border', () => {
    const c = closeUp(page, [20, 20, 200, 16]);
    expect(c && c.width > 600 && c.height > 48).toBe(true);
    expect(closeUp(page, [0, 0, 0, 0])).toBeNull();
  });

  it('a GSTIN is replaced only by one that passes its check character', async () => {
    const h = header({ vendorGstin: field('29BBQPN1599K1Z0', 4999) });
    const note = await secondLook(
      h,
      images,
      scripted([{ text: 'GSTIN:29BBQPN1599K1ZO', conf: 70 }]),
    );
    expect(h.vendorGstin.value).toBe('29BBQPN1599K1ZO');
    expect(h.vendorGstin.confidenceBp).toBe(9800);
    expect(note).toMatch(/supplier's GSTIN/);
    const g = header({ vendorGstin: field('29KKMPE4321H1ZC', 4999) });
    await secondLook(g, images, scripted([{ text: 'GSTIN:29KKMPE4321H1ZC', conf: 95 }]));
    expect(g.vendorGstin).toMatchObject({ value: '29KKMPE4321H1ZC', confidenceBp: 4999 });
  });

  it('another value is confirmed only when read the same again, confidently', async () => {
    const same = header({ invoiceNumber: field('77/26-27', 6300) });
    await secondLook(same, images, scripted([{ text: ':77/26-27', conf: 94 }]));
    expect(same.invoiceNumber).toMatchObject({ value: '77/26-27', confidenceBp: 9400 });

    const other = header({ invoiceNumber: field('77/26-27', 6300) });
    await secondLook(other, images, scripted([{ text: '71/26-27', conf: 96 }]));
    expect(other.invoiceNumber).toMatchObject({ value: '77/26-27', confidenceBp: 6300 });

    const unsure = header({ invoiceNumber: field('77/26-27', 6300) });
    await secondLook(unsure, images, scripted([{ text: '77/26-27', conf: 70 }]));
    expect(unsure.invoiceNumber.confidenceBp).toBe(6300);

    const total = header({ totalPaise: field(3_000_000, 6000) });
    await secondLook(total, images, scripted([{ text: '30,000.00!', conf: 93 }]));
    expect(total.totalPaise.confidenceBp).toBe(9300);
  });

  it('a value already certain is not looked at again', async () => {
    const ocr = scripted();
    await secondLook(header({ invoiceNumber: field('77/26-27', 9500) }), images, ocr);
    expect(ocr.calls).toBe(0);
  });
});
