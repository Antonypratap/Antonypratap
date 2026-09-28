import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidStorageKeyError,
  LocalDocumentStorage,
  StorageIntegrityError,
  StorageNotFoundError,
  StorageUnavailableError,
  assertSafeKey,
  sha256Hex,
  type DocumentStorage,
} from './index';

const PDF = new TextEncoder().encode('%PDF-1.4 test document %%EOF');
const META = { mime: 'application/pdf', sha256: sha256Hex(PDF) };
const KEY = '01K0000000000000000000ABCD.pdf';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function localStorage(): LocalDocumentStorage {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-storage-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return new LocalDocumentStorage(join(dir, 'uploads'));
}

describe('document storage (Phase 6B)', () => {
  it('store, retrieve, exists, metadata, delete', async () => {
    const storage: DocumentStorage = localStorage();
    expect(await storage.exists(KEY)).toBe(false);
    expect(await storage.metadata(KEY)).toBeNull();
    await storage.put(KEY, PDF, META);
    expect(await storage.exists(KEY)).toBe(true);
    expect(await storage.metadata(KEY)).toEqual({ sizeBytes: PDF.length });
    expect(Buffer.from(await storage.get(KEY))).toEqual(Buffer.from(PDF));
    await storage.put('imports/01K00000000000000000000001/1-Vendors (1).xlsx', PDF, META);
    expect(await storage.exists('imports/01K00000000000000000000001/1-Vendors (1).xlsx')).toBe(
      true,
    );
    await storage.delete(KEY);
    expect(await storage.exists(KEY)).toBe(false);
    await storage.check();
  });

  it('checksum: the original bytes are verified on read; a mismatch is refused, never used', async () => {
    const s = localStorage();
    await s.put(KEY, PDF, META);
    expect(Buffer.from(await s.get(KEY, { sha256: META.sha256 }))).toEqual(Buffer.from(PDF));
    await expect(s.get(KEY, { sha256: '0'.repeat(64) })).rejects.toBeInstanceOf(
      StorageIntegrityError,
    );
    // Writes are checked too: what is stored is exactly what was checksummed.
    await expect(s.put(KEY, PDF, { ...META, sha256: '0'.repeat(64) })).rejects.toBeInstanceOf(
      StorageIntegrityError,
    );
  });

  it('a corrupted file on disk is detected before any reader sees it', async () => {
    const s = localStorage();
    await s.put(KEY, PDF, META);
    writeFileSync(s.pathOf(KEY), 'tampered');
    let read = false;
    await expect(
      s.withLocalFile(
        KEY,
        async () => {
          read = true;
        },
        META,
      ),
    ).rejects.toBeInstanceOf(StorageIntegrityError);
    expect(read).toBe(false);
  });

  it('a missing file is a typed not-found, for get, metadata and reading', async () => {
    const s = localStorage();
    await expect(s.get(KEY)).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await s.metadata(KEY)).toBeNull();
    await expect(s.withLocalFile(KEY, async () => 'x')).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  it('keys cannot escape the store: traversal, absolute paths, null bytes, hidden files', () => {
    for (const bad of [
      '../etc/passwd',
      'a/../../b',
      '/etc/passwd',
      '..',
      '.hidden',
      'a\\b',
      'a\u0000b',
      '',
      'a//b',
      'x/'.repeat(5) + 'y',
      'imports/..%2f/x',
      'C:\\temp\\x',
    ])
      expect(() => assertSafeKey(bad), JSON.stringify(bad)).toThrow(InvalidStorageKeyError);
    expect(() => assertSafeKey(KEY)).not.toThrow();
  });

  it('writes are atomic (no partial file under the real key) and stay inside the root', async () => {
    const s = localStorage();
    await s.put(KEY, PDF, META);
    expect(readdirSync(s.root)).toEqual([KEY]);
    await expect(s.put('../outside.pdf', PDF, META)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(s.put('/tmp/absolute.pdf', PDF, META)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    expect(() => s.pathOf('../../x')).toThrow(InvalidStorageKeyError);
    expect(readdirSync(join(s.root, '..'))).toEqual(['uploads']);
  });

  it('an unusable storage folder makes check() fail as unavailable (readiness)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'veyra-storage-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'not-a-folder'), 'x');
    const s = new LocalDocumentStorage(join(dir, 'not-a-folder', 'uploads'));
    await expect(s.check()).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});
