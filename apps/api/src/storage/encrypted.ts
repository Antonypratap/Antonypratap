import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyringError, type Keyring } from './keyring';
import { StorageDecryptError, sha256Hex, verifyChecksum, type DocumentStorage } from './storage';

/**
 * Envelope encryption at rest for stored documents (docs/SECURITY.md, "Encryption at rest").
 *
 * Every object gets its own random 256-bit data key (DEK). The bytes are encrypted with it using
 * AES-256-GCM (Node's OpenSSL), and the DEK itself is wrapped, also with AES-256-GCM, by the
 * keyring's active key-encryption key (KEK). Both use a fresh random 96-bit IV, so no IV is ever
 * reused with a key. The storage key is bound in as additional data, so a file copied or moved to
 * another key does not decrypt. Rotation re-wraps only the small DEK (`rewrap`); the document's
 * ciphertext never changes.
 *
 * Stored layout (all lengths fixed except the key id):
 *   "VYE1" | id length (1 byte) | KEK id | wrap IV (12) | wrap tag (16) | wrapped DEK (32)
 *          | IV (12) | tag (16) | ciphertext
 *
 * Fails closed: altered bytes, an unknown key id, or (once `requireEncrypted`) an unencrypted file
 * raise StorageDecryptError, and nothing is ever returned unverified. Unencrypted files written
 * before encryption was switched on stay readable only while `requireEncrypted` is false, so the
 * migration (`npm run security:encrypt-existing`) can run first.
 */

const MAGIC = Buffer.from('VYE1', 'ascii');
const IV = 12;
const TAG = 16;
const DEK = 32;

export interface EnvelopeOptions {
  keyring: Keyring;
  /** Refuse to read files that are not encrypted (set once existing files were migrated). */
  requireEncrypted: boolean;
}

const aad = (purpose: 'dek' | 'doc', key: string) =>
  Buffer.from(`veyrafy:${purpose}:v1:${key}`, 'utf8');

export function isSealed(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && Buffer.from(bytes.subarray(0, 4)).equals(MAGIC);
}

/** Encrypts `plain` for storage under `key` with a new DEK wrapped by the active KEK. */
export function seal(keyring: Keyring, key: string, plain: Uint8Array): Buffer {
  const dek = randomBytes(DEK);
  try {
    const wrapIv = randomBytes(IV);
    const w = createCipheriv('aes-256-gcm', keyring.active, wrapIv);
    w.setAAD(aad('dek', key));
    const wrapped = Buffer.concat([w.update(dek), w.final()]);
    const iv = randomBytes(IV);
    const c = createCipheriv('aes-256-gcm', dek, iv);
    c.setAAD(aad('doc', key));
    const body = Buffer.concat([c.update(plain), c.final()]);
    const id = Buffer.from(keyring.activeId, 'ascii');
    return Buffer.concat([
      MAGIC,
      Buffer.from([id.length]),
      id,
      wrapIv,
      w.getAuthTag(),
      wrapped,
      iv,
      c.getAuthTag(),
      body,
    ]);
  } finally {
    dek.fill(0);
  }
}

interface Header {
  kekId: string;
  wrapIv: Buffer;
  wrapTag: Buffer;
  wrapped: Buffer;
  /** Everything after the wrapped DEK: IV, tag and ciphertext (unchanged by a rewrap). */
  rest: Buffer;
}

function header(sealed: Uint8Array): Header {
  const b = Buffer.from(sealed);
  if (!isSealed(b) || b.length < 5) throw new StorageDecryptError('malformed');
  const idLen = b[4] ?? 0;
  let at = 5;
  const kekId = b.subarray(at, at + idLen).toString('ascii');
  at += idLen;
  if (idLen === 0 || b.length < at + IV + TAG + DEK + IV + TAG)
    throw new StorageDecryptError('malformed');
  const wrapIv = b.subarray(at, (at += IV));
  const wrapTag = b.subarray(at, (at += TAG));
  const wrapped = b.subarray(at, (at += DEK));
  return { kekId, wrapIv, wrapTag, wrapped, rest: b.subarray(at) };
}

function unwrap(keyring: Keyring, key: string, h: Header): Buffer {
  let kek: Buffer;
  try {
    kek = keyring.key(h.kekId);
  } catch (e) {
    if (e instanceof KeyringError) throw new StorageDecryptError('unknown_key');
    throw e;
  }
  try {
    const d = createDecipheriv('aes-256-gcm', kek, h.wrapIv);
    d.setAAD(aad('dek', key));
    d.setAuthTag(h.wrapTag);
    return Buffer.concat([d.update(h.wrapped), d.final()]);
  } catch {
    throw new StorageDecryptError('tampered');
  }
}

/** Decrypts what `seal` wrote under the same `key`. StorageDecryptError on any mismatch. */
export function open(keyring: Keyring, key: string, sealed: Uint8Array): Buffer {
  const h = header(sealed);
  const dek = unwrap(keyring, key, h);
  try {
    if (h.rest.length < IV + TAG) throw new StorageDecryptError('malformed');
    const d = createDecipheriv('aes-256-gcm', dek, h.rest.subarray(0, IV));
    d.setAAD(aad('doc', key));
    d.setAuthTag(h.rest.subarray(IV, IV + TAG));
    return Buffer.concat([d.update(h.rest.subarray(IV + TAG)), d.final()]);
  } catch (e) {
    if (e instanceof StorageDecryptError) throw e;
    throw new StorageDecryptError('tampered');
  } finally {
    dek.fill(0);
  }
}

/** The KEK id an encrypted object was written with (null: not encrypted). */
export function sealedKeyId(bytes: Uint8Array): string | null {
  return isSealed(bytes) ? header(bytes).kekId : null;
}

/**
 * The same object with its DEK re-wrapped by the active KEK (key rotation): the document's own
 * ciphertext is unchanged. Null when it already uses the active key.
 */
export function rewrap(keyring: Keyring, key: string, sealed: Uint8Array): Buffer | null {
  const h = header(sealed);
  if (h.kekId === keyring.activeId) return null;
  const dek = unwrap(keyring, key, h);
  try {
    const wrapIv = randomBytes(IV);
    const w = createCipheriv('aes-256-gcm', keyring.active, wrapIv);
    w.setAAD(aad('dek', key));
    const wrapped = Buffer.concat([w.update(dek), w.final()]);
    const id = Buffer.from(keyring.activeId, 'ascii');
    return Buffer.concat([
      MAGIC,
      Buffer.from([id.length]),
      id,
      wrapIv,
      w.getAuthTag(),
      wrapped,
      h.rest,
    ]);
  } finally {
    dek.fill(0);
  }
}

/**
 * A DocumentStorage that encrypts everything it stores (wrapping another storage, e.g. the local
 * folder). Callers see plaintext only in memory; checksums are of the plaintext, as recorded at
 * upload.
 */
export class EncryptedDocumentStorage implements DocumentStorage {
  readonly kind = 'encrypted' as const;

  constructor(
    readonly inner: DocumentStorage,
    readonly options: EnvelopeOptions,
  ) {}

  async put(key: string, bytes: Uint8Array, meta: { mime: string; sha256: string }): Promise<void> {
    // What is encrypted is exactly what the caller checksummed.
    verifyChecksum(bytes, meta);
    const sealed = seal(this.options.keyring, key, bytes);
    await this.inner.put(key, sealed, {
      mime: 'application/octet-stream',
      sha256: sha256Hex(sealed),
    });
  }

  async get(key: string, verify?: { sha256: string }): Promise<Uint8Array> {
    const stored = await this.inner.get(key);
    if (!isSealed(stored)) {
      // Written before encryption was switched on: readable only until the migration is done.
      if (this.options.requireEncrypted) throw new StorageDecryptError('not_encrypted');
      return verifyChecksum(stored, verify);
    }
    return verifyChecksum(new Uint8Array(open(this.options.keyring, key, stored)), verify);
  }

  exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }

  metadata(key: string): Promise<{ sizeBytes: number } | null> {
    return this.inner.metadata(key);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  check(): Promise<void> {
    return this.inner.check();
  }

  /** Whether the stored object is encrypted (the migration tool's progress check). */
  async isEncrypted(key: string): Promise<boolean> {
    return isSealed(await this.inner.get(key));
  }

  /**
   * Encrypts an object stored before encryption was switched on (verified against its recorded
   * checksum first, and read back after). Returns false when it already was encrypted.
   */
  async encryptExisting(key: string, verify?: { sha256: string }): Promise<boolean> {
    const stored = await this.inner.get(key);
    if (isSealed(stored)) return false;
    verifyChecksum(stored, verify);
    const sha256 = verify?.sha256 ?? sha256Hex(stored);
    await this.put(key, stored, { mime: 'application/octet-stream', sha256 });
    // Read back through the decrypting path: the stored copy must give the original bytes.
    await this.get(key, { sha256 });
    return true;
  }

  /** Re-wraps an object's data key with the active KEK (rotation). False when nothing changed. */
  async rewrapExisting(key: string): Promise<boolean> {
    const stored = await this.inner.get(key);
    if (!isSealed(stored)) return false;
    const next = rewrap(this.options.keyring, key, stored);
    if (!next) return false;
    const plainHash = sha256Hex(open(this.options.keyring, key, next));
    await this.inner.put(key, next, { mime: 'application/octet-stream', sha256: sha256Hex(next) });
    await this.get(key, { sha256: plainHash });
    return true;
  }
}
