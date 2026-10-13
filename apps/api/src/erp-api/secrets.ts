import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Secret } from '../secret';

/**
 * Encryption at rest for connection credentials (API keys, passwords, tokens, client secrets).
 * AES-256-GCM with a fresh 96-bit IV per value and the purpose bound in as additional data, so a
 * ciphertext copied to another row or purpose does not decrypt. The key comes from
 * VEYRA_SECRETS_KEY (32 random bytes, base64) and never leaves this module; its short id is stored
 * with each value so a future key can be rotated in.
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

export class SecretBox {
  readonly #key: Buffer;
  readonly keyId: string;

  private constructor(key: Buffer) {
    this.#key = key;
    // Identifies the key without revealing it (first 8 hex characters of its SHA-256).
    this.keyId = createHash('sha256').update(key).digest('hex').slice(0, 8);
  }

  /** From VEYRA_SECRETS_KEY: base64 of exactly 32 bytes. */
  static fromBase64(value: Secret | string): SecretBox {
    const raw = typeof value === 'string' ? value : value.reveal();
    const key = Buffer.from(raw.trim(), 'base64');
    if (key.length !== 32)
      throw new SecretsKeyError('VEYRA_SECRETS_KEY must be 32 random bytes, base64-encoded.');
    return new SecretBox(key);
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
    if (sealed.keyId !== this.keyId)
      throw new SecretsKeyError('These credentials were saved with a different secrets key.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(sealed.iv, 'base64'));
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
