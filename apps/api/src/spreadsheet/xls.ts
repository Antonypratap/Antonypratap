import { classifyFormat, MAX_COLUMNS, MAX_ROWS, SpreadsheetError } from './xlsx';
import type { Cell, Sheet, SheetRow, Workbook } from './xlsx';

/**
 * Just enough of the legacy Excel 97–2003 format (.xls) to read simple tables, the same subset
 * the .xlsx reader covers and returning the same Workbook (docs/ARCHITECTURE.md §14.4: no
 * spreadsheet library). A .xls is a Compound File (a small file system of sectors) holding a
 * "Workbook" stream of BIFF8 records.
 *
 * Read: worksheets, shared and inline strings, numbers, booleans, errors, the value a formula
 * last showed (formulas are never evaluated), and which numbers are dates or percentages.
 * Refused: encrypted workbooks and formats older than Excel 97 (BIFF5 and before).
 * Every structure is bounded: sector chains are checked for loops and the file's own size, and
 * the row and column limits are those of the .xlsx reader.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const MAX_REGULAR = 0xfffffffa;
/** The largest workbook stream read (the upload limit is far below this). */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

/** Whether bytes start like a Compound File (a .xls, or another legacy Office file). */
export function isCompoundFile(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

const fail = (why: string): never => {
  throw new SpreadsheetError(`This is not a readable .xls file (${why}).`);
};

// ── The Compound File container ────────────────────────────────────────────

function compoundStream(bytes: Uint8Array, names: readonly string[]): Uint8Array | null {
  if (!isCompoundFile(bytes)) fail('not an Excel 97–2003 workbook');
  if (bytes.length < 512) fail('too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);
  const shift = u16(0x1e);
  if (shift !== 9 && shift !== 12) fail('unknown sector size');
  const sectorSize = 1 << shift;
  const miniShift = u16(0x20);
  if (miniShift !== 6) fail('unknown mini sector size');
  const miniSize = 1 << miniShift;
  const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize) + 1;
  const sectorOffset = (n: number) => {
    if (n >= MAX_REGULAR || n >= sectorCount) fail('a sector outside the file');
    return (n + 1) * sectorSize;
  };
  const entriesPerSector = sectorSize / 4;

  // The FAT's own sectors: 109 in the header, the rest in a chain of DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const s = u32(0x4c + i * 4);
    if (s !== FREE) fatSectors.push(s);
  }
  let difat = u32(0x44);
  const seenDifat = new Set<number>();
  while (difat !== END_OF_CHAIN && difat !== FREE) {
    if (seenDifat.has(difat) || seenDifat.size > sectorCount) fail('a loop in the sector table');
    seenDifat.add(difat);
    const o = sectorOffset(difat);
    for (let i = 0; i < entriesPerSector - 1; i += 1) {
      const s = u32(o + i * 4);
      if (s !== FREE) fatSectors.push(s);
    }
    difat = u32(o + (entriesPerSector - 1) * 4);
  }
  if (fatSectors.length > sectorCount) fail('a sector table larger than the file');
  const fat: number[] = [];
  for (const s of fatSectors) {
    const o = sectorOffset(s);
    for (let i = 0; i < entriesPerSector; i += 1) fat.push(u32(o + i * 4));
  }

  /** The sectors of a chain, in order; a loop or a sector outside the file is refused. */
  const chain = (start: number, table: readonly number[], limit: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    let s = start;
    while (s !== END_OF_CHAIN) {
      if (s === FREE || s >= table.length) fail('a broken sector chain');
      if (seen.has(s)) fail('a loop in a sector chain');
      if (out.length >= limit) fail('a sector chain longer than the file');
      seen.add(s);
      out.push(s);
      s = table[s] as number;
    }
    return out;
  };
  const readChain = (start: number, size: number): Uint8Array => {
    const sectors = chain(start, fat, sectorCount);
    if (size > sectors.length * sectorSize) fail('a stream larger than its sectors');
    const out = new Uint8Array(size);
    let at = 0;
    for (const s of sectors) {
      if (at >= size) break;
      const o = sectorOffset(s);
      const n = Math.min(sectorSize, size - at);
      out.set(bytes.subarray(o, o + n), at);
      at += n;
    }
    return out;
  };

  // The directory: 128-byte entries; the first is the root, which holds the mini stream.
  const dir = readChain(u32(0x30), chain(u32(0x30), fat, sectorCount).length * sectorSize);
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries: { name: string; type: number; start: number; size: number }[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameBytes = Math.min(dv.getUint16(o + 64, true), 64);
    let name = '';
    for (let i = 0; i + 1 < nameBytes - 1; i += 2)
      name += String.fromCharCode(dv.getUint16(o + i, true));
    entries.push({
      name,
      type: dir[o + 66] as number,
      start: dv.getUint32(o + 116, true),
      size: dv.getUint32(o + 120, true),
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) fail('no root directory');
  const found = entries.find(
    (e) => e.type === 2 && names.some((n) => n.toLowerCase() === e.name.toLowerCase()),
  );
  if (!found) return null;
  if (found.size > MAX_STREAM_BYTES) fail('a workbook stream too large');
  const cutoff = u32(0x38) || 4096;
  if (found.size >= cutoff) return readChain(found.start, found.size);

  // A small stream lives in the mini stream, in 64-byte mini sectors with their own table.
  const rootEntry = root as { start: number; size: number };
  const mini = readChain(rootEntry.start, rootEntry.size);
  const miniFatBytes = readChain(u32(0x3c), chain(u32(0x3c), fat, sectorCount).length * sectorSize);
  const miniFat: number[] = [];
  const mv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  for (let o = 0; o + 4 <= miniFatBytes.length; o += 4) miniFat.push(mv.getUint32(o, true));
  const sectors = chain(found.start, miniFat, Math.ceil(mini.length / miniSize) + 1);
  if (found.size > sectors.length * miniSize) fail('a stream larger than its sectors');
  const out = new Uint8Array(found.size);
  let at = 0;
  for (const s of sectors) {
    if (at >= found.size) break;
    const o = s * miniSize;
    const n = Math.min(miniSize, found.size - at);
    if (o + n > mini.length) fail('a mini sector outside the mini stream');
    out.set(mini.subarray(o, o + n), at);
    at += n;
  }
  return out;
}

// ── BIFF8 records ───────────────────────────────────────────────────────────

interface BiffRecord {
  type: number;
  data: Uint8Array;
  /** Offset of the record header in the stream (sheets are located by it). */
  offset: number;
}

function records(stream: Uint8Array): BiffRecord[] {
  const out: BiffRecord[] = [];
  let o = 0;
  while (o + 4 <= stream.length) {
    const type = (stream[o] as number) | ((stream[o + 1] as number) << 8);
    const len = (stream[o + 2] as number) | ((stream[o + 3] as number) << 8);
    if (o + 4 + len > stream.length) fail('a record runs past the end of the workbook');
    out.push({ type, data: stream.subarray(o + 4, o + 4 + len), offset: o });
    o += 4 + len;
  }
  return out;
}

const R = {
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
} as const;

const ERRORS: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
};

/** Reads bytes across a record and its CONTINUE records, as BIFF8 strings require. */
class Segments {
  private i = 0;
  private o = 0;
  constructor(private readonly parts: readonly Uint8Array[]) {}
  private current(): Uint8Array {
    while (this.i < this.parts.length && this.o >= (this.parts[this.i] as Uint8Array).length) {
      this.i += 1;
      this.o = 0;
    }
    if (this.i >= this.parts.length) fail('a string runs past its record');
    return this.parts[this.i] as Uint8Array;
  }
  get done(): boolean {
    let i = this.i;
    let o = this.o;
    while (i < this.parts.length && o >= (this.parts[i] as Uint8Array).length) {
      i += 1;
      o = 0;
    }
    return i >= this.parts.length;
  }
  u8(): number {
    const p = this.current();
    const v = p[this.o] as number;
    this.o += 1;
    return v;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number): void {
    for (let left = n; left > 0;) {
      const p = this.current();
      const take = Math.min(left, p.length - this.o);
      this.o += take;
      left -= take;
    }
  }
  /** `count` characters; a CONTINUE in the middle starts with a new compression flag. */
  chars(count: number, highByte: boolean): string {
    let wide = highByte;
    let s = '';
    let left = count;
    while (left > 0) {
      if (this.i < this.parts.length && this.o >= (this.parts[this.i] as Uint8Array).length) {
        this.i += 1;
        this.o = 0;
        wide = (this.u8() & 0x01) === 1;
      }
      const p = this.current();
      const room = Math.floor((p.length - this.o) / (wide ? 2 : 1));
      if (room === 0) fail('a string runs past its record');
      const n = Math.min(left, room);
      for (let k = 0; k < n; k += 1) {
        s += String.fromCharCode(
          wide ? (p[this.o] as number) | ((p[this.o + 1] as number) << 8) : (p[this.o] as number),
        );
        this.o += wide ? 2 : 1;
      }
      left -= n;
    }
    return s;
  }
  /** An XLUnicodeRichExtendedString (the shared-string table's entries). */
  richString(): string {
    const cch = this.u16();
    const flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    const s = this.chars(cch, (flags & 0x01) === 1);
    this.skip(runs * 4 + ext);
    return s;
  }
}

/** An XLUnicodeString inside one record: cch (u16), flags, characters. */
function unicodeString(data: Uint8Array, at: number, cchBytes: 1 | 2 = 2): string {
  const seg = new Segments([data.subarray(at)]);
  const cch = cchBytes === 1 ? seg.u8() : seg.u16();
  const flags = seg.u8();
  return seg.chars(cch, (flags & 0x01) === 1);
}

const f64 = (d: Uint8Array, at: number) =>
  new DataView(d.buffer, d.byteOffset + at, 8).getFloat64(0, true);

/** An RK number: a compressed double or integer, optionally divided by 100. */
function rk(v: number): number {
  const div100 = (v & 0x01) === 1;
  let n: number;
  if (v & 0x02) n = v >> 2;
  else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, v & 0xfffffffc, true);
    n = buf.getFloat64(0, true);
  }
  return div100 ? n / 100 : n;
}

const numberText = (n: number) => (Number.isFinite(n) ? String(n) : '');
/** Little-endian reads inside a record; a byte past the end reads as 0. */
const b8 = (d: Uint8Array, at: number): number => d[at] ?? 0;
const b16 = (d: Uint8Array, at: number): number => b8(d, at) | (b8(d, at + 1) << 8);
const b32 = (d: Uint8Array, at: number): number => (b16(d, at) | (b16(d, at + 2) << 16)) >>> 0;

export function readXls(bytes: Uint8Array): Workbook {
  const stream = compoundStream(bytes, ['Workbook']);
  if (!stream) {
    if (compoundStream(bytes, ['Book']))
      throw new SpreadsheetError(
        'This .xls was saved by an Excel older than Excel 97. Open it and save it as .xlsx.',
      );
    fail('no workbook inside');
  }
  const recs = records(stream as Uint8Array);
  const first = recs[0];
  if (!first || first.type !== R.BOF || first.data.length < 4) fail('no workbook header');
  const version = b16((first as BiffRecord).data, 0);
  if (version !== 0x0600)
    throw new SpreadsheetError(
      'This .xls was saved by an Excel older than Excel 97. Open it and save it as .xlsx.',
    );

  // The workbook globals: up to the first EOF.
  let date1904 = false;
  const customFormats = new Map<number, string>();
  /** Each XF (cell style) record's number-format id, in order: a cell refers to its XF. */
  const xfIds: number[] = [];
  const sheetsAt: { name: string; offset: number }[] = [];
  let sst: string[] = [];
  let i = 1;
  for (; i < recs.length; i += 1) {
    const r = recs[i] as BiffRecord;
    const d = r.data;
    if (r.type === R.EOF) break;
    if (r.type === R.FILEPASS)
      throw new SpreadsheetError(
        'This .xls is password-protected. Remove the password in Excel, then upload it again.',
      );
    if (r.type === R.DATEMODE && d.length >= 2) date1904 = b16(d, 0) === 1;
    else if (r.type === R.FORMAT && d.length >= 5)
      customFormats.set(b16(d, 0), unicodeString(d, 2));
    else if (r.type === R.XF && d.length >= 4) xfIds.push(b16(d, 2));
    else if (r.type === R.BOUNDSHEET && d.length >= 8) {
      const kind = d[5];
      if (kind === 0)
        sheetsAt.push({
          offset: b32(d, 0),
          name: unicodeString(d, 6, 1),
        });
    } else if (r.type === R.SST && d.length >= 8) {
      const parts = [d.subarray(8)];
      while ((recs[i + 1] as BiffRecord | undefined)?.type === R.CONTINUE) {
        i += 1;
        parts.push((recs[i] as BiffRecord).data);
      }
      const unique = b32(d, 4);
      const seg = new Segments(parts);
      sst = [];
      for (let k = 0; k < unique && !seg.done; k += 1) sst.push(seg.richString());
    }
  }
  // XF records hold format ids; turn them into what the .xlsx reader reports.
  const formats = xfIds.map((id) => classifyFormat(id, customFormats));

  const byOffset = new Map(recs.map((r, idx) => [r.offset, idx]));
  const sheets: Sheet[] = [];
  for (const s of sheetsAt) {
    const start = byOffset.get(s.offset);
    if (start === undefined || (recs[start] as BiffRecord).type !== R.BOF) continue;
    sheets.push({ name: s.name, rows: readSheet(recs, start + 1, sst, formats, s.name) });
  }
  return { sheets, date1904 };
}

function readSheet(
  recs: readonly BiffRecord[],
  from: number,
  sst: readonly string[],
  formats: readonly Cell['format'][],
  sheetName: string,
): SheetRow[] {
  const rows = new Map<number, Cell[]>();
  const put = (row: number, col: number, cell: Cell) => {
    if (col >= MAX_COLUMNS) return;
    let cells = rows.get(row);
    if (!cells) {
      if (rows.size >= MAX_ROWS)
        throw new SpreadsheetError(`Sheet "${sheetName}" has more than ${MAX_ROWS} rows.`);
      cells = [];
      rows.set(row, cells);
    }
    while (cells.length < col)
      cells.push({ text: '', kind: 'empty', format: null, formula: false });
    cells[col] = cell;
  };
  const num = (n: number, xf: number, formula = false): Cell => ({
    text: numberText(n),
    kind: 'number',
    format: formats[xf] ?? null,
    formula,
  });
  for (let i = from; i < recs.length; i += 1) {
    const r = recs[i] as BiffRecord;
    const d = r.data;
    if (r.type === R.EOF) break;
    if (d.length < 6 && r.type !== R.STRING) continue;
    const row = b16(d, 0);
    const col = b16(d, 2);
    const xf = b16(d, 4);
    switch (r.type) {
      case R.LABELSST:
        if (d.length >= 10)
          put(row, col, {
            text: sst[b32(d, 6)] ?? '',
            kind: 'string',
            format: null,
            formula: false,
          });
        break;
      case R.LABEL:
        put(row, col, { text: unicodeString(d, 6), kind: 'string', format: null, formula: false });
        break;
      case R.NUMBER:
        if (d.length >= 14) put(row, col, num(f64(d, 6), xf));
        break;
      case R.RK:
        if (d.length >= 10) put(row, col, num(rk(b32(d, 6)), xf));
        break;
      case R.MULRK: {
        const n = Math.floor((d.length - 6) / 6);
        for (let k = 0; k < n; k += 1) {
          const at = 4 + k * 6;
          const cxf = b16(d, at);
          const v = b32(d, at + 2);
          put(row, col + k, num(rk(v), cxf));
        }
        break;
      }
      case R.BOOLERR:
        if (d.length >= 8)
          put(
            row,
            col,
            d[7] === 1
              ? { text: ERRORS[b8(d, 6)] ?? '#ERROR', kind: 'error', format: null, formula: false }
              : { text: d[6] ? 'TRUE' : 'FALSE', kind: 'boolean', format: null, formula: false },
          );
        break;
      case R.FORMULA: {
        if (d.length < 14) break;
        // The value the formula last showed; it is never calculated here.
        if (d[12] === 0xff && d[13] === 0xff) {
          const t = d[6];
          if (t === 0) {
            const next = recs[i + 1];
            const text = next?.type === R.STRING ? unicodeString(next.data, 0) : '';
            put(row, col, { text, kind: 'string', format: null, formula: true });
          } else if (t === 1)
            put(row, col, {
              text: d[8] ? 'TRUE' : 'FALSE',
              kind: 'boolean',
              format: null,
              formula: true,
            });
          else if (t === 2)
            put(row, col, {
              text: ERRORS[b8(d, 8)] ?? '#ERROR',
              kind: 'error',
              format: null,
              formula: true,
            });
          else put(row, col, { text: '', kind: 'empty', format: null, formula: true });
        } else put(row, col, num(f64(d, 6), xf, true));
        break;
      }
      default:
        break;
    }
  }
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([row, cells]) => ({ rowNumber: row + 1, cells }));
}
