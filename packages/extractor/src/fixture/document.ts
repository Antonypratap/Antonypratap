/**
 * Deterministic demo documents. The same scenario always renders to the same bytes, so its
 * SHA-256 is stable and the FixtureExtractor can recognise an uploaded fixture file.
 *
 * Both writers are hand-rolled on purpose: no compression library, whose output could change
 * between versions and silently change every fixture hash.
 */

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A one-page PDF with a real text layer (Helvetica, WinAnsi). Non-Latin-1 characters become "?". */
export function renderPdf(lines: readonly string[]): Uint8Array {
  const safe = (s: string): string =>
    s
      .replace(/[^\x20-\x7e]/g, '?')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  const text = lines
    .map((l, i) => `BT /F1 10 Tf 48 ${800 - i * 16} Td (${safe(l)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${off.toString().padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(body);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat([latin1(type), data]);
  return concat([u32(data.length), typed, u32(crc32(typed))]);
}

/** zlib stream made of stored (uncompressed) deflate blocks: byte-for-byte deterministic. */
function zlibStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let at = 0; at < data.length || at === 0; at += 65_535) {
    const block = data.subarray(at, at + 65_535);
    const final = at + 65_535 >= data.length ? 1 : 0;
    const len = block.length;
    parts.push(
      Uint8Array.of(final, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff),
      block,
    );
    if (final) break;
  }
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  parts.push(u32(((b << 16) | a) >>> 0));
  return concat(parts);
}

/**
 * A small grey "phone photo" PNG. The pixels only suggest a document (rows of text-like bars);
 * the invoice text is kept in a tEXt chunk so the file stays self-describing.
 */
export function renderPng(lines: readonly string[], seed: number): Uint8Array {
  const width = 200;
  const height = 280;
  const raw = new Uint8Array((width + 1) * height);
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    const row = Math.floor((y - 20) / 12);
    const inText = y > 20 && (y - 20) % 12 < 6 && row < lines.length;
    const textLen = inText ? 30 + (((lines[row]?.length ?? 0) * 3) % 140) : 0;
    for (let x = 0; x < width; x++) {
      const base = inText && x > 16 && x < 16 + textLen ? 90 : 222;
      raw[y * (width + 1) + 1 + x] = Math.max(0, Math.min(255, base + Math.floor(rand() * 26)));
    }
  }
  const header = concat([u32(width), u32(height), Uint8Array.of(8, 0, 0, 0, 0)]);
  const description = latin1(`Description\0${lines.join(' | ').replace(/[^\x20-\x7e]/g, '?')}`);
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('tEXt', description),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}
