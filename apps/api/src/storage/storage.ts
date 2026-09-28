import { createHash } from 'node:crypto';

/**
 * Where uploaded documents live (Phase 6B). The workflow sees only this port, never a filesystem
 * path. Today there is one implementation, LocalDocumentStorage (a folder; a persistent disk when
 * deployed). Object storage can be added later as another implementation of this interface.
 *
 * Keys are opaque, validated relative names (`<documentId>.pdf`, `imports/<id>/1-file.xlsx`).
 * They never come from a user: filenames are metadata only, so no upload can choose where it is
 * written.
 */
export interface DocumentStorage {
  readonly kind: 'local';
  /** Stores bytes under `key` (replacing nothing: keys are unique per upload). */
  put(key: string, bytes: Uint8Array, meta: { mime: string; sha256: string }): Promise<void>;
  /** The bytes under `key`. With `sha256`, they are verified before they are returned. */
  get(key: string, verify?: { sha256: string }): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  /** Size of the stored object, or null when it does not exist. */
  metadata(key: string): Promise<{ sizeBytes: number } | null>;
  /** Deletes the object (demo reset only; production never deletes documents). */
  delete(key: string): Promise<void>;
  /**
   * Runs `fn` with a local file holding the object (the document readers need a path). For local
   * storage that is the stored file itself; a remote store would provide a private temporary
   * copy, removed afterwards.
   */
  withLocalFile<T>(
    key: string,
    fn: (path: string) => Promise<T>,
    verify?: { sha256: string },
  ): Promise<T>;
  /** Readiness: throws StorageUnavailableError when documents cannot be stored or read. */
  check(): Promise<void>;
}

/** Storage could not be reached or used just now. Retryable. */
export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';
  readonly retryable = true;
  constructor(options?: { cause?: unknown }) {
    super('Document storage is not available right now.', options);
    this.name = 'StorageUnavailableError';
  }
}

export class StorageNotFoundError extends Error {
  readonly code = 'STORAGE_NOT_FOUND';
  readonly retryable = false;
  constructor() {
    super('The stored document is missing.');
    this.name = 'StorageNotFoundError';
  }
}

/** The stored bytes do not match the checksum recorded at upload. Never retried or used. */
export class StorageIntegrityError extends Error {
  readonly code = 'STORAGE_INTEGRITY';
  readonly retryable = false;
  constructor() {
    super('The stored document does not match the uploaded file.');
    this.name = 'StorageIntegrityError';
  }
}

export class InvalidStorageKeyError extends Error {
  readonly code = 'STORAGE_INVALID_KEY';
  readonly retryable = false;
  constructor() {
    super('Invalid storage key.');
    this.name = 'InvalidStorageKeyError';
  }
}

export type StorageError =
  StorageUnavailableError | StorageNotFoundError | StorageIntegrityError | InvalidStorageKeyError;

export function isStorageError(error: unknown): error is StorageError {
  return (
    error instanceof StorageUnavailableError ||
    error instanceof StorageNotFoundError ||
    error instanceof StorageIntegrityError ||
    error instanceof InvalidStorageKeyError
  );
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._() -]{0,127}$/;

/**
 * Keys are 1–4 segments of letters, digits, `._() -`, each starting with a letter or digit: no
 * absolute paths, no `..`, no backslashes, no control characters, no hidden files.
 */
export function assertSafeKey(key: string): void {
  const segments = key.split('/');
  if (
    key.length > 300 ||
    segments.length > 4 ||
    segments.some((s) => !SEGMENT.test(s) || s.includes('..') || s.endsWith(' '))
  )
    throw new InvalidStorageKeyError();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyChecksum(bytes: Uint8Array, verify?: { sha256: string }): Uint8Array {
  if (verify && sha256Hex(bytes) !== verify.sha256) throw new StorageIntegrityError();
  return bytes;
}
