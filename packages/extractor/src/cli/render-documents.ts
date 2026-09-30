/**
 * Renders the synthetic invoices in `samples/documents.ts` to real documents with headless
 * Chromium (used by `npm run fixtures:documents` and by the API benchmarks, docs/PERFORMANCE.md).
 */
import type { Browser } from 'playwright-core';
import { BUYER, type DocumentSample, type SampleInvoice } from '../samples/documents';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function invoiceHtml(inv: SampleInvoice, sample: DocumentSample): string {
  const hasCode = inv.lines.some((l) => l.code);
  const hasDisc = inv.lines.some((l) => l.disc);
  const head = [
    'Sl',
    'Description',
    ...(hasCode ? ['Item Code'] : []),
    'HSN/SAC',
    'Qty',
    'UoM',
    'Rate',
    ...(hasDisc ? ['Disc'] : []),
    'GST %',
    'Taxable Value',
  ];
  const right = new Set(['Qty', 'Rate', 'Disc', 'GST %', 'Taxable Value']);
  const cells = (l: SampleInvoice['lines'][number], i: number) => [
    String(i + 1),
    l.description,
    ...(hasCode ? [l.code ?? ''] : []),
    l.hsn,
    l.qty,
    l.uom,
    l.rate,
    ...(hasDisc ? [l.disc ?? ''] : []),
    l.gst,
    l.taxable,
  ];
  const rows = inv.lines
    .map(
      (l, i) =>
        `<tr${inv.twoPages && i > 0 ? ' class="break"' : ''}>${cells(l, i)
          .map((c, k) => `<td${right.has(head[k] ?? '') ? ' class="r"' : ''}>${esc(c)}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  const tot = (label: string, value: string | undefined) =>
    value === undefined ? '' : `<tr><td>${label}</td><td class="r">${esc(value)}</td></tr>`;
  const rate = (inv.lines[0]?.gst ?? '18%').replace('%', '');
  const half = String(Number(rate) / 2);
  const total = inv.smudgedTotal
    ? `<canvas class="smudge" width="170" height="26" data-text="₹ ${esc(inv.total)}"></canvas>`
    : `<b>₹ ${esc(inv.total)}</b>`;
  return `
<section class="invoice">
  <h1>TAX INVOICE</h1>
  <div class="grid">
    <div class="box"><b class="vendor">${esc(inv.vendor.name)}</b><br>${esc(inv.vendor.address)}${
      inv.vendor.gstin ? `<br>GSTIN: ${inv.vendor.gstin}` : ''
    }${inv.vendor.pan ? `<br>PAN: ${inv.vendor.pan}` : ''}<br>Phone: 080 2345 6789</div>
    <div class="box">Invoice No: ${esc(inv.number)}<br>Invoice Date: ${inv.date}${
      inv.po ? `<br>PO No: ${inv.po}` : ''
    }<br>Place of Supply: ${esc(inv.placeOfSupply)}</div>
  </div>
  <div class="grid">
    <div class="box"><b>Bill To:</b><br>${esc(BUYER.name)}<br>${esc(BUYER.address)}<br>GSTIN: ${BUYER.gstin}</div>
    <div class="box"><b>Ship To:</b><br>${esc(BUYER.name)}<br>${esc(BUYER.shipTo)}<br>State: ${esc(BUYER.state)}</div>
  </div>
  <table class="lines"><thead><tr>${head
    .map((h) => `<th${right.has(h) ? ' class="r"' : ''}>${h}</th>`)
    .join('')}</tr></thead><tbody>${rows}</tbody></table>
  <table class="tot">
    ${tot('Taxable Value', inv.taxable)}
    ${tot(`CGST @ ${half}%`, inv.cgst)}
    ${tot(`SGST @ ${half}%`, inv.sgst)}
    ${tot(`IGST @ ${rate}%`, inv.igst)}
    ${tot('Round Off', inv.roundOff)}
    <tr><td><b>Grand Total</b></td><td class="r">${total}</td></tr>
  </table>
  <p class="foot">This is a computer-generated invoice. Synthetic sample for Veyrafy testing (${esc(
    sample.file,
  )}).</p>
</section>`;
}

export function pageHtml(sample: DocumentSample): string {
  const blur = sample.kind === 'blurry-jpeg' ? 'filter: blur(1.6px);' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:0;background:#fff}
  .invoice{width:730px;padding:32px;${blur}} .invoice + .invoice{break-before:page}
  h1{font-size:18px;text-align:center;margin:0 0 12px} .vendor{font-size:15px}
  table{border-collapse:collapse;width:100%} .lines td,.lines th{border:1px solid #444;padding:4px 6px}
  th{background:#eee;text-align:left} .r{text-align:right}
  .grid{display:flex;justify-content:space-between;margin:8px 0} .box{width:48%}
  .tot{width:45%;margin-left:55%;margin-top:8px} .tot td{padding:2px 6px}
  .foot{margin-top:24px;color:#555;font-size:10px}
  tr.break{break-before:page} thead{display:table-header-group}
  </style></head><body>${sample.invoices.map((i) => invoiceHtml(i, sample)).join('')}
  <script>
    for (const c of document.querySelectorAll('canvas.smudge')) {
      const g = c.getContext('2d'); g.filter = 'blur(3.5px)'; g.font = 'bold 15px Arial';
      g.fillStyle = '#222'; g.fillText(c.dataset.text, 8, 19);
      g.filter = 'none'; g.fillStyle = 'rgba(90,70,40,0.35)'; g.fillRect(20, 4, 90, 18);
    }
  </script></body></html>`;
}

/** A PDF with one JPEG page image and no text layer: what a scanner produces. */
export function scannedPdf(jpeg: Buffer): Buffer {
  let w = 0;
  let h = 0;
  for (let i = 2; i < jpeg.length;) {
    const marker = jpeg[i + 1] ?? 0;
    const len = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      h = jpeg.readUInt16BE(i + 5);
      w = jpeg.readUInt16BE(i + 7);
      break;
    }
    i += 2 + len;
  }
  const pw = 595;
  const ph = Math.round((595 * h) / w);
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im1 Do Q`;
  const objects: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from('\nendstream'),
    ]),
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let at = parts[0]?.length ?? 0;
  objects.forEach((o, i) => {
    offsets.push(at);
    const b = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      typeof o === 'string' ? Buffer.from(o) : o,
      Buffer.from('\nendobj\n'),
    ]);
    parts.push(b);
    at += b.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
        .join(
          '',
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

/** One sample as the bytes of its kind (text PDF, photo, scan). */
export async function renderSample(browser: Browser, sample: DocumentSample): Promise<Buffer> {
  const page = await browser.newPage({
    viewport: { width: 800, height: 1100 },
    deviceScaleFactor: 2,
  });
  try {
    await page.setContent(pageHtml(sample), { waitUntil: 'load' });
    const shot = (type: 'png' | 'jpeg', quality?: number) =>
      page
        .locator('.invoice')
        .first()
        .screenshot({ type, ...(quality ? { quality } : {}) });
    switch (sample.kind) {
      case 'text-pdf':
        return await page.pdf({ format: 'A4', printBackground: true });
      case 'png':
        return await shot('png');
      case 'jpeg':
        return await shot('jpeg', 82);
      case 'blurry-jpeg':
        return await shot('jpeg', 60);
      case 'scanned-pdf':
        return scannedPdf(await shot('jpeg', 80));
    }
  } finally {
    await page.close();
  }
}
