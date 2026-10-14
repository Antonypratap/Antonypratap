import { createHash } from 'node:crypto';

/**
 * Where uploaded documents live (Phase 6B). The workflow sees only this port, never a filesystem
 * path. LocalDocumentStorage keeps the bytes in a folder (a persistent disk when deployed);
 * EncryptedDocumentStorage wraps it so every file is encrypted at rest (docs/SECURITY.md). Readers
 * get the bytes in memory, so no decrypted copy is ever written to disk.
 *
 * Keys are opaque, validated relative names (`<documentId>.pdf`, `imports/<id>/1-file.xlsx`).
 * They never come from a user: filenames are metadata only, so no upload can choose where it is
 * written.
 */
export interface DocumentStorage {
  readonly kind: 'local' | 'encrypted';
  /** Stores bytes under `key` (replacing nothing: keys are unique per upload). */
  put(key: string, bytes: Uint8Array, meta: { mime: string; sha256: string }): Promise<void>;
  /** The bytes under `key`. With `sha256`, they are verified before they are returned. */
  get(key: string, verify?: { sha256: string }): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  /** Size of the stored object, or null when it does not exist. */
  metadata(key: string): Promise<{ sizeBytes: number } | null>;
  /** Deletes the object (deletion by a person or a retention policy, demo reset). */
  delete(key: string): Promise<void>;
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

/**
 * A stored document could not be decrypted: altered, written with a key this Veyrafy does not
 * have, or (when encryption is required) stored unencrypted. Fails closed: never retried, never
 * read as plaintext. The message names no key and no content.
 */
export class StorageDecryptError extends Error {
  readonly code = 'STORAGE_DECRYPT';
  readonly retryable = false;
  constructor(readonly reason: 'tampered' | 'unknown_key' | 'not_encrypted' | 'malformed') {
    super('The stored document could not be decrypted.');
    this.name = 'StorageDecryptError';
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
  | StorageUnavailableError
  | StorageNotFoundError
  | StorageIntegrityError
  | StorageDecryptError
  | InvalidStorageKeyError;

export function isStorageError(error: unknown): error is StorageError {
  return (
    error instanceof StorageUnavailableError ||
    error instanceof StorageNotFoundError ||
    error instanceof StorageIntegrityError ||
    error instanceof StorageDecryptError ||
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
