import { inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP reader and writer for XLSX files. Uploaded files are untrusted: the reader refuses
 * encryption, ZIP64 and oversized content, and never inflates more than it was told to expect.
 * The writer stores entries uncompressed with fixed timestamps, so its output is deterministic.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 200,
  maxEntryBytes: 30 * 1024 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
};

interface Entry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Reads a ZIP archive's directory; entries are inflated only when asked for. */
export function readZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): { names: string[]; read: (name: string) => Buffer | null } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 is not supported');
  if (count > limits.maxEntries) throw new ZipError('too many entries');
  if (cdOffset + cdSize > buf.length) throw new ZipError('truncated archive');

  const entries = new Map<string, Entry>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new ZipError('corrupt central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new ZipError('encrypted files are not supported');
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression in ${name}`);
    if (size === 0xffffffff || compressedSize === 0xffffffff)
      throw new ZipError('ZIP64 is not supported');
    if (size > limits.maxEntryBytes) throw new ZipError(`${name} is too large`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError('archive content is too large');
    entries.set(name, { method, compressedSize, size, localOffset });
  }

  const read = (name: string): Buffer | null => {
    const e = entries.get(name);
    if (!e) return null;
    const lp = e.localOffset;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== 0x04034b50)
      throw new ZipError('corrupt local header');
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const data = buf.subarray(start, start + e.compressedSize);
    if (data.length !== e.compressedSize) throw new ZipError('truncated entry');
    if (e.method === 0) return Buffer.from(data);
    // Never inflate beyond the declared size (zip-bomb guard).
    const out = inflateRawSync(data, { maxOutputLength: Math.max(e.size, 1) });
    if (out.length !== e.size) throw new ZipError(`${name} has an unexpected size`);
    return out;
  };
  return { names: [...entries.keys()], read };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Writes a ZIP archive with stored (uncompressed) entries and a fixed 1980-01-01 timestamp. */
export function writeZip(files: readonly { name: string; data: Uint8Array }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const DOS_DATE = 0x0021; // 1980-01-01
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
