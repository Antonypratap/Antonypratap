import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SecretBox, SecretsKeyError } from './secrets';

const key = () => randomBytes(32).toString('base64');

describe('credentials encryption at rest', () => {
  it('round-trips, and the stored form never contains the value', () => {
    const box = SecretBox.fromBase64(key());
    const sealed = box.seal('made-up-api-key-123', 'erp:apiKey');
    expect(JSON.stringify(sealed)).not.toContain('made-up-api-key-123');
    const opened = box.open(sealed, 'erp:apiKey');
    expect(opened.reveal()).toBe('made-up-api-key-123');
    expect(String(opened)).toBe('[secret]');
    expect(inspect(opened)).toBe('[secret]');
  });

  it('uses a fresh IV each time', () => {
    const box = SecretBox.fromBase64(key());
    expect(box.seal('same', 'p').ciphertext).not.toBe(box.seal('same', 'p').ciphertext);
  });

  it('refuses an altered ciphertext, another purpose, or another key', () => {
    const box = SecretBox.fromBase64(key());
    const sealed = box.seal('value', 'erp:password');
    const flipped = Buffer.from(sealed.ciphertext, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      box.open({ ...sealed, ciphertext: flipped.toString('base64') }, 'erp:password'),
    ).toThrow(SecretsKeyError);
    expect(() => box.open(sealed, 'erp:apiKey')).toThrow(SecretsKeyError);
    expect(() => SecretBox.fromBase64(key()).open(sealed, 'erp:password')).toThrow(
      /different secrets key/,
    );
  });

  it('rotation: values sealed with a previous key still open; new values use the new key', () => {
    const oldKey = key();
    const newKey = key();
    const sealed = SecretBox.fromBase64(oldKey).seal('made-up-token', 'erp:token');
    const rotated = SecretBox.fromBase64(newKey, oldKey);
    expect(rotated.isStale(sealed)).toBe(true);
    expect(rotated.open(sealed, 'erp:token').reveal()).toBe('made-up-token');
    const resealed = rotated.seal('made-up-token', 'erp:token');
    expect(rotated.isStale(resealed)).toBe(false);
    // Once re-sealed, the old key can go: the new key alone opens it.
    expect(SecretBox.fromBase64(newKey).open(resealed, 'erp:token').reveal()).toBe('made-up-token');
    // Without the previous key, the old value fails closed.
    expect(() => SecretBox.fromBase64(newKey).open(sealed, 'erp:token')).toThrow(SecretsKeyError);
    // A malformed previous key is refused, and its message names no key.
    let message = '';
    try {
      SecretBox.fromBase64(newKey, `${oldKey},short`);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/VEYRA_SECRETS_KEYS_PREVIOUS/);
    expect(message).not.toContain(oldKey);
  });

  it('requires a 32-byte key', () => {
    expect(() => SecretBox.fromBase64(randomBytes(16).toString('base64'))).toThrow(SecretsKeyError);
    expect(() => SecretBox.fromBase64('')).toThrow(SecretsKeyError);
  });
});
