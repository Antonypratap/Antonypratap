/**
 * Test only: builds small legacy Excel (.xls) files byte by byte, so the reader is tested on
 * workbooks with known content (and deliberately broken ones) without committing binary files.
 * Covers only what the tests use; this is not a general .xls writer.
 */

export const u16 = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
export const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};
export const f64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n, true);
  return b;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Characters, compressed (1 byte) when they all fit, else UTF-16. */
export function chars(s: string): { wide: boolean; bytes: Uint8Array } {
  const wide = [...s].some((c) => c.charCodeAt(0) > 0xff);
  const bytes = new Uint8Array(s.length * (wide ? 2 : 1));
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (wide) {
      bytes[i * 2] = c & 0xff;
      bytes[i * 2 + 1] = c >> 8;
    } else bytes[i] = c;
  }
  return { wide, bytes };
}

/** An XLUnicodeString: character count (1 or 2 bytes), flags, characters. */
export function xlString(s: string, cchBytes: 1 | 2 = 2): Uint8Array {
  const c = chars(s);
  return cat(
    cchBytes === 1 ? Uint8Array.of(s.length) : u16(s.length),
    Uint8Array.of(c.wide ? 1 : 0),
    c.bytes,
  );
}

export const rec = (type: number, ...parts: Uint8Array[]) => {
  const data = cat(...parts);
  return cat(u16(type), u16(data.length), data);
};

export const T = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  FORMAT: 0x041e,
  XF: 0x00e0,
  DATEMODE: 0x0022,
  FILEPASS: 0x002f,
};

export const bof = (kind: 'globals' | 'sheet', version = 0x0600) =>
  rec(T.BOF, u16(version), u16(kind === 'globals' ? 0x0005 : 0x0010), new Uint8Array(12));
export const eof = () => rec(T.EOF);
/** An XF (cell style) record pointing at a number format. */
export const xf = (formatId: number) => rec(T.XF, u16(0), u16(formatId), new Uint8Array(16));
export const format = (id: number, code: string) => rec(T.FORMAT, u16(id), xlString(code));
const cellHead = (row: number, col: number, xfIndex: number) =>
  cat(u16(row), u16(col), u16(xfIndex));
export const labelSst = (row: number, col: number, index: number, xfIndex = 0) =>
  rec(T.LABELSST, cellHead(row, col, xfIndex), u32(index));
export const label = (row: number, col: number, s: string) =>
  rec(T.LABEL, cellHead(row, col, 0), xlString(s));
export const number = (row: number, col: number, n: number, xfIndex = 0) =>
  rec(T.NUMBER, cellHead(row, col, xfIndex), f64(n));
/** An RK number holding an integer (optionally ×100). */
export const rkInt = (n: number, div100 = false) => ((n << 2) | 0x02 | (div100 ? 1 : 0)) >>> 0;
export const rk = (row: number, col: number, value: number, xfIndex = 0) =>
  rec(T.RK, cellHead(row, col, xfIndex), u32(value));
export const mulrk = (row: number, firstCol: number, values: { xf: number; rk: number }[]) =>
  rec(
    T.MULRK,
    u16(row),
    u16(firstCol),
    ...values.map((v) => cat(u16(v.xf), u32(v.rk))),
    u16(firstCol + values.length - 1),
  );
export const boolErr = (row: number, col: number, value: number, isError: boolean) =>
  rec(T.BOOLERR, cellHead(row, col, 0), Uint8Array.of(value, isError ? 1 : 0));
export const formulaNumber = (row: number, col: number, n: number, xfIndex = 0) =>
  rec(T.FORMULA, cellHead(row, col, xfIndex), f64(n), new Uint8Array(6));
export const formulaString = (row: number, col: number, s: string) => [
  rec(
    T.FORMULA,
    cellHead(row, col, 0),
    Uint8Array.of(0, 0, 0, 0, 0, 0, 0xff, 0xff),
    new Uint8Array(6),
  ),
  rec(T.STRING, xlString(s)),
];

/**
 * A shared-string table. `splitAt` cuts the record into SST + CONTINUE at that byte of the
 * string data; a cut inside a string's characters repeats the compression flag, as Excel does.
 */
export function sst(strings: string[], splitInside?: { string: number; afterChars: number }) {
  const head = cat(u32(strings.length), u32(strings.length));
  const pieces: Uint8Array[] = [];
  const conts: Uint8Array[][] = [];
  let current = pieces;
  strings.forEach((s, i) => {
    const c = chars(s);
    const header = cat(u16(s.length), Uint8Array.of(c.wide ? 1 : 0));
    if (splitInside && splitInside.string === i) {
      const per = c.wide ? 2 : 1;
      const cut = splitInside.afterChars * per;
      current.push(header, c.bytes.subarray(0, cut));
      const next: Uint8Array[] = [Uint8Array.of(c.wide ? 1 : 0), c.bytes.subarray(cut)];
      conts.push(next);
      current = next;
    } else current.push(header, c.bytes);
  });
  return cat(rec(T.SST, head, ...pieces), ...conts.map((parts) => rec(T.CONTINUE, ...parts)));
}

/**
 * The Workbook stream: globals (with BOUNDSHEET records placed and pointed at each sheet), then
 * each sheet's records between its BOF and EOF.
 */
export function workbookStream(
  globals: Uint8Array[],
  sheets: { name: string; records: Uint8Array[] }[],
  version = 0x0600,
): Uint8Array {
  const boundSheet = (offset: number, name: string) =>
    rec(T.BOUNDSHEET, u32(offset), Uint8Array.of(0, 0), xlString(name, 1));
  const sheetBodies = sheets.map((s) => cat(bof('sheet', version), ...s.records, eof()));
  const globalsLength = (offsets: number[]) =>
    cat(
      bof('globals', version),
      ...globals,
      ...sheets.map((s, i) => boundSheet(offsets[i] ?? 0, s.name)),
      eof(),
    ).length;
  const size = globalsLength(sheets.map(() => 0));
  const offsets: number[] = [];
  let at = size;
  for (const b of sheetBodies) {
    offsets.push(at);
    at += b.length;
  }
  return cat(
    bof('globals', version),
    ...globals,
    ...sheets.map((s, i) => boundSheet(offsets[i] ?? 0, s.name)),
    eof(),
    ...sheetBodies,
  );
}

const SECTOR = 512;
const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;

/**
 * A Compound File (version 3, 512-byte sectors) holding one stream. Streams under 4096 bytes go
 * in the mini stream unless `regular` is set. `corrupt` may change the sector table before it
 * is written (to test broken files).
 */
export function compoundFile(
  input: Uint8Array,
  opts: { name?: string; regular?: boolean; corrupt?: (fat: number[]) => void } = {},
): Uint8Array {
  let stream = input;
  const name = opts.name ?? 'Workbook';
  const mini = !opts.regular && stream.length < 4096;
  // A stream under 4096 bytes must live in the mini stream; for regular sectors, pad it (the
  // padding reads as empty records after the last one).
  if (opts.regular && stream.length < 4096)
    stream = cat(stream, new Uint8Array(4096 - stream.length));
  const sectorsFor = (n: number) => Math.max(1, Math.ceil(n / SECTOR));
  const miniStream = mini ? cat(stream, new Uint8Array((64 - (stream.length % 64)) % 64)) : null;
  const streamSectors = mini ? 0 : sectorsFor(stream.length);
  const miniStreamSectors = miniStream ? sectorsFor(miniStream.length) : 0;
  const miniFatSectors = mini ? 1 : 0;
  let fatSectors = 1;
  while (
    fatSectors * (SECTOR / 4) <
    fatSectors + 1 + streamSectors + miniFatSectors + miniStreamSectors
  )
    fatSectors += 1;
  const dirAt = fatSectors;
  const streamAt = dirAt + 1;
  const miniFatAt = streamAt + streamSectors;
  const miniStreamAt = miniFatAt + miniFatSectors;
  const total = miniStreamAt + miniStreamSectors;

  const fat: number[] = new Array(fatSectors * (SECTOR / 4)).fill(FREE);
  for (let i = 0; i < fatSectors; i += 1) fat[i] = FATSECT;
  fat[dirAt] = END;
  const link = (start: number, count: number) => {
    for (let i = 0; i < count; i += 1) fat[start + i] = i === count - 1 ? END : start + i + 1;
  };
  link(streamAt, streamSectors);
  link(miniFatAt, miniFatSectors);
  link(miniStreamAt, miniStreamSectors);
  opts.corrupt?.(fat);

  const header = new Uint8Array(SECTOR);
  const hv = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  hv.setUint16(0x18, 0x3e, true);
  hv.setUint16(0x1a, 3, true);
  hv.setUint16(0x1c, 0xfffe, true);
  hv.setUint16(0x1e, 9, true);
  hv.setUint16(0x20, 6, true);
  hv.setUint32(0x2c, fatSectors, true);
  hv.setUint32(0x30, dirAt, true);
  hv.setUint32(0x38, 4096, true);
  hv.setUint32(0x3c, mini ? miniFatAt : END, true);
  hv.setUint32(0x40, miniFatSectors, true);
  hv.setUint32(0x44, END, true);
  for (let i = 0; i < 109; i += 1) hv.setUint32(0x4c + i * 4, i < fatSectors ? i : FREE, true);

  const entry = (entryName: string, type: number, start: number, size: number) => {
    const e = new Uint8Array(128);
    const ev = new DataView(e.buffer);
    for (let i = 0; i < entryName.length; i += 1)
      ev.setUint16(i * 2, entryName.charCodeAt(i), true);
    ev.setUint16(64, (entryName.length + 1) * 2, true);
    e[66] = type;
    ev.setUint32(68, FREE, true);
    ev.setUint32(72, FREE, true);
    ev.setUint32(76, type === 5 ? 1 : FREE, true);
    ev.setUint32(116, start, true);
    ev.setUint32(120, size, true);
    return e;
  };
  const dir = cat(
    entry('Root Entry', 5, mini ? miniStreamAt : END, miniStream?.length ?? 0),
    entry(name, 2, mini ? 0 : streamAt, stream.length),
    new Uint8Array(256),
  );
  const fatBytes = cat(...fat.map((n) => u32(n)));
  const miniFat = new Uint8Array(mini ? SECTOR : 0).fill(0xff);
  if (mini) {
    const mv = new DataView(miniFat.buffer);
    const count = (miniStream as Uint8Array).length / 64;
    for (let i = 0; i < count; i += 1) mv.setUint32(i * 4, i === count - 1 ? END : i + 1, true);
  }
  const pad = (b: Uint8Array, sectors: number) =>
    cat(b, new Uint8Array(sectors * SECTOR - b.length));
  const body = cat(
    pad(fatBytes, fatSectors),
    pad(dir, 1),
    mini ? new Uint8Array(0) : pad(stream, streamSectors),
    mini ? miniFat : new Uint8Array(0),
    miniStream ? pad(miniStream, miniStreamSectors) : new Uint8Array(0),
  );
  if (body.length !== total * SECTOR) throw new Error('compound file layout mismatch');
  return cat(header, body);
}
