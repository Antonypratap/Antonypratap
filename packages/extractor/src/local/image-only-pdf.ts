/**
 * Test support: turns a PDF into one with NO text layer, each page stored as horizontal gray image
 * strips, the way many scanners and "print to PDF" tools store a page. Used to prove such files
 * are read as images; only ever applied to the synthetic fixtures.
 */
import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { renderPdfPagePng } from './pdf';

const STRIPS = 7;

/** Every page of `source` drawn at 300 dpi, then stored as gray image strips: no text at all. */
export async function imageOnlyStripPdf(source: Uint8Array, pages: number): Promise<Uint8Array> {
  const objects: (string | Buffer)[] = [];
  const add = (o: string | Buffer) => objects.push(o) && objects.length;
  const catalog = add('');
  const tree = add('');
  const kids: number[] = [];
  for (let n = 1; n <= pages; n++) {
    const rendered = await renderPdfPagePng(source, n, 300);
    if (!rendered) throw new Error(`no page ${n}`);
    const png = PNG.sync.read(rendered.png);
    const scale = 300 / 72;
    const [wPt, hPt] = [png.width / scale, png.height / scale];
    const stripPx = Math.ceil(png.height / STRIPS);
    const xobjects: string[] = [];
    let content = '';
    for (let s = 0; s < STRIPS; s++) {
      const y0 = s * stripPx;
      const h = Math.min(stripPx, png.height - y0);
      const gray = Buffer.alloc(png.width * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < png.width; x++) {
          const i = ((y0 + y) * png.width + x) * 4;
          gray[y * png.width + x] = Math.round(
            ((png.data[i] ?? 0) + (png.data[i + 1] ?? 0) + (png.data[i + 2] ?? 0)) / 3,
          );
        }
      const data = deflateSync(gray);
      const img = add(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${png.width} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
            'latin1',
          ),
          data,
          Buffer.from('\nendstream', 'latin1'),
        ]),
      );
      xobjects.push(`/S${s} ${img} 0 R`);
      const hStrip = h / scale;
      const yStrip = hPt - y0 / scale - hStrip;
      content += `q ${wPt.toFixed(3)} 0 0 ${hStrip.toFixed(3)} 0 ${yStrip.toFixed(3)} cm /S${s} Do Q\n`;
    }
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${wPt.toFixed(3)} ${hPt.toFixed(3)}] /Resources << /XObject << ${xobjects.join(' ')} >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const head = Buffer.from('%PDF-1.4\n', 'latin1');
  const parts: Buffer[] = [head];
  const offsets: number[] = [];
  let length = head.length;
  objects.forEach((o, i) => {
    offsets.push(length);
    const body = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      typeof o === 'string' ? Buffer.from(o, 'latin1') : o,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(body);
    length += body.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
