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

  it('requires a 32-byte key', () => {
    expect(() => SecretBox.fromBase64(randomBytes(16).toString('base64'))).toThrow(SecretsKeyError);
    expect(() => SecretBox.fromBase64('')).toThrow(SecretsKeyError);
  });
});
