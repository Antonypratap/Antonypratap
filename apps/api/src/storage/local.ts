import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  StorageNotFoundError,
  StorageUnavailableError,
  assertSafeKey,
  verifyChecksum,
  type DocumentStorage,
} from './storage';

/**
 * Documents on the local filesystem (development, or a persistent volume). Every key is validated
 * and resolved inside the root; writes go to a temporary file first and are renamed into place, so
 * a crash never leaves a half-written document under a real key.
 */
export class LocalDocumentStorage implements DocumentStorage {
  readonly kind = 'local' as const;
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The absolute path for a key, guaranteed to be inside the root. */
  pathOf(key: string): string {
    assertSafeKey(key);
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new StorageNotFoundError();
    return path;
  }

  async put(key: string, bytes: Uint8Array, meta: { mime: string; sha256: string }): Promise<void> {
    const path = this.pathOf(key);
    // What is written is exactly what the caller checksummed.
    verifyChecksum(bytes, meta);
    const temp = `${path}.${randomBytes(6).toString('hex')}.partial`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw fsError(error);
    }
  }

  async get(key: string, verify?: { sha256: string }): Promise<Uint8Array> {
    const path = this.pathOf(key);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch (error) {
      throw fsError(error);
    }
    return verifyChecksum(bytes, verify);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.metadata(key)) !== null;
  }

  async metadata(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const s = await stat(this.pathOf(key));
      return s.isFile() ? { sizeBytes: s.size } : null;
    } catch (error) {
      const e = fsError(error);
      if (e instanceof StorageNotFoundError) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.pathOf(key), { force: true });
    } catch (error) {
      throw fsError(error);
    }
  }

  async withLocalFile<T>(
    key: string,
    fn: (path: string) => Promise<T>,
    verify?: { sha256: string },
  ): Promise<T> {
    // Verify (and prove it exists) before the reader sees it.
    if (verify) await this.get(key, verify);
    else if (!(await this.exists(key))) throw new StorageNotFoundError();
    return fn(this.pathOf(key));
  }

  async check(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.R_OK | constants.W_OK);
    } catch (error) {
      throw new StorageUnavailableError({ cause: error });
    }
  }
}

function fsError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR')
    return new StorageNotFoundError();
  if (error instanceof Error && 'retryable' in error) return error;
  return new StorageUnavailableError({ cause: error });
}
