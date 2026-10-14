import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Secret } from '../secret';

/**
 * Encryption at rest for connection credentials (API keys, passwords, tokens, client secrets).
 * AES-256-GCM with a fresh 96-bit IV per value and the purpose bound in as additional data, so a
 * ciphertext copied to another row or purpose does not decrypt. The key comes from
 * VEYRA_SECRETS_KEY (32 random bytes, base64) and never leaves this module; its short id is stored
 * with each value. Rotation: the new key becomes VEYRA_SECRETS_KEY, the old one moves to
 * VEYRA_SECRETS_KEYS_PREVIOUS (still read, never written), and `npm run security:encrypt-existing
 * -- --rewrap` re-encrypts every saved value with the new key, after which the old one is removed.
 */

export interface Sealed {
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class SecretsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsKeyError';
  }
}

// Identifies a key without revealing it (first 8 hex characters of its SHA-256).
const idOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

function keyOf(raw: string, name: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32)
    throw new SecretsKeyError(`${name} must be 32 random bytes, base64-encoded.`);
  return key;
}

export class SecretBox {
  readonly #key: Buffer;
  /** Earlier keys, by id: values sealed with them still open (rotation), nothing new uses them. */
  readonly #previous: ReadonlyMap<string, Buffer>;
  readonly keyId: string;

  private constructor(key: Buffer, previous: Buffer[]) {
    this.#key = key;
    this.keyId = idOf(key);
    this.#previous = new Map(previous.map((k) => [idOf(k), k]));
  }

  /**
   * From VEYRA_SECRETS_KEY (base64 of exactly 32 bytes) and, during a rotation,
   * VEYRA_SECRETS_KEYS_PREVIOUS (comma-separated, same form).
   */
  static fromBase64(value: Secret | string, previous?: Secret | string | null): SecretBox {
    const raw = typeof value === 'string' ? value : value.reveal();
    const prev = previous ? (typeof previous === 'string' ? previous : previous.reveal()) : '';
    return new SecretBox(
      keyOf(raw, 'VEYRA_SECRETS_KEY'),
      prev
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => keyOf(p, 'Each key in VEYRA_SECRETS_KEYS_PREVIOUS')),
    );
  }

  /** Whether a value was sealed with an earlier key (and should be re-sealed). */
  isStale(sealed: Pick<Sealed, 'keyId'>): boolean {
    return sealed.keyId !== this.keyId;
  }

  seal(plain: string, purpose: string): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(purpose, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      keyId: this.keyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  /** Throws SecretsKeyError when the value was sealed with another key, altered, or for another purpose. */
  open(sealed: Sealed, purpose: string): Secret {
    const key = sealed.keyId === this.keyId ? this.#key : this.#previous.get(sealed.keyId);
    if (!key)
      throw new SecretsKeyError('These credentials were saved with a different secrets key.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(Buffer.from(purpose, 'utf8'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return new Secret(plain.toString('utf8'));
    } catch {
      throw new SecretsKeyError('The saved credentials could not be decrypted.');
    }
  }
}
