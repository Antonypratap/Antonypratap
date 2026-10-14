import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from '../config';
import { createLogger } from '../http/logging';
import {
  EncryptedDocumentStorage,
  Keyring,
  KeyringError,
  LocalDocumentStorage,
  StorageDecryptError,
  StorageIntegrityError,
  createStorage,
  sha256Hex,
} from './index';
import { isSealed, open, rewrap, seal, sealedKeyId } from './encrypted';

/**
 * Encryption at rest for stored documents (docs/SECURITY.md). Synthetic bytes and made-up keys
 * only: no real document and no real key is ever used.
 */

const PLAIN = new TextEncoder().encode('%PDF-1.4 made-up invoice INV-0001 total 1,180.00 %%EOF');
const META = { mime: 'application/pdf', sha256: sha256Hex(PLAIN) };
const KEY = '01K0000000000000000000ABCD.pdf';
const k = () => randomBytes(32).toString('base64');
const K1 = k();
const K2 = k();

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function stores(keys = `k1:${K1}`, active = 'k1', requireEncrypted = false) {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-enc-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const local = new LocalDocumentStorage(join(dir, 'uploads'));
  const enc = new EncryptedDocumentStorage(local, {
    keyring: Keyring.parse(keys, active),
    requireEncrypted,
  });
  return { dir, local, enc };
}

describe('document encryption at rest', () => {
  it('stores ciphertext, returns the original bytes, and verifies the recorded checksum', async () => {
    const { local, enc } = stores();
    await enc.put(KEY, PLAIN, META);
    const onDisk = readFileSync(local.pathOf(KEY));
    expect(isSealed(onDisk)).toBe(true);
    expect(onDisk.includes(Buffer.from('INV-0001'))).toBe(false);
    expect(onDisk.includes(Buffer.from('%PDF'))).toBe(false);
    expect(Buffer.from(await enc.get(KEY, META))).toEqual(Buffer.from(PLAIN));
    await expect(enc.get(KEY, { sha256: '0'.repeat(64) })).rejects.toBeInstanceOf(
      StorageIntegrityError,
    );
  });

  it('every write uses a fresh data key and IV: the same document never encrypts the same way', () => {
    const ring = Keyring.parse(`k1:${K1}`, 'k1');
    const a = seal(ring, KEY, PLAIN);
    const b = seal(ring, KEY, PLAIN);
    expect(a.equals(b)).toBe(false);
    expect(open(ring, KEY, a)).toEqual(Buffer.from(PLAIN));
    expect(open(ring, KEY, b)).toEqual(Buffer.from(PLAIN));
  });

  it('a changed byte anywhere (header, wrapped key, tag or body) is refused, never returned', async () => {
    const { local, enc } = stores();
    await enc.put(KEY, PLAIN, META);
    const good = readFileSync(local.pathOf(KEY));
    for (const at of [6, 20, 40, 70, good.length - 5]) {
      const bad = Buffer.from(good);
      bad[at] = (bad[at] ?? 0) ^ 0x01;
      writeFileSync(local.pathOf(KEY), bad);
      const err = await enc.get(KEY).catch((e: unknown) => e);
      expect(err, `byte ${String(at)}`).toBeInstanceOf(StorageDecryptError);
    }
  });

  it('a file moved to another key does not decrypt (the key is bound into the ciphertext)', () => {
    const ring = Keyring.parse(`k1:${K1}`, 'k1');
    const sealed = seal(ring, KEY, PLAIN);
    expect(() => open(ring, 'other.pdf', sealed)).toThrow(StorageDecryptError);
  });

  it('a wrong or missing key fails closed, naming no key', async () => {
    const { local, enc } = stores();
    await enc.put(KEY, PLAIN, META);
    const sealed = readFileSync(local.pathOf(KEY));
    // Same id, different key material: the wrapped data key does not open.
    expect(() => open(Keyring.parse(`k1:${K2}`, 'k1'), KEY, sealed)).toThrow(StorageDecryptError);
    // The id is not in the ring at all.
    const err = (() => {
      try {
        open(Keyring.parse(`k2:${K2}`, 'k2'), KEY, sealed);
      } catch (e) {
        return e as StorageDecryptError;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(StorageDecryptError);
    expect(err?.reason).toBe('unknown_key');
    expect(JSON.stringify([err?.message, err?.stack])).not.toContain(K1);
  });

  it('malformed stored bytes are refused', () => {
    const ring = Keyring.parse(`k1:${K1}`, 'k1');
    for (const bad of [Buffer.from('VYE1'), Buffer.from('VYE1\u0000'), Buffer.from('VYE1\u0002k1')])
      expect(() => open(ring, KEY, bad)).toThrow(StorageDecryptError);
  });

  it('files stored before encryption stay readable until encryption is required, then fail closed', async () => {
    const { local, enc } = stores();
    await local.put(KEY, PLAIN, META);
    expect(Buffer.from(await enc.get(KEY, META))).toEqual(Buffer.from(PLAIN));
    const strict = new EncryptedDocumentStorage(local, {
      keyring: Keyring.parse(`k1:${K1}`, 'k1'),
      requireEncrypted: true,
    });
    await expect(strict.get(KEY)).rejects.toMatchObject({ reason: 'not_encrypted' });
    // The migration encrypts it in place (verified), after which the strict store reads it.
    expect(await enc.encryptExisting(KEY, META)).toBe(true);
    expect(await enc.encryptExisting(KEY, META)).toBe(false);
    expect(Buffer.from(await strict.get(KEY, META))).toEqual(Buffer.from(PLAIN));
  });

  it('the migration refuses to encrypt a file that no longer matches its recorded checksum', async () => {
    const { local, enc } = stores();
    await local.put(KEY, PLAIN, META);
    writeFileSync(local.pathOf(KEY), 'tampered');
    await expect(enc.encryptExisting(KEY, META)).rejects.toBeInstanceOf(StorageIntegrityError);
    expect(readFileSync(local.pathOf(KEY), 'utf8')).toBe('tampered');
  });

  it('rotation: a new key is added, old files stay readable, and rewrapping moves them to it', async () => {
    const { local, enc } = stores();
    await enc.put(KEY, PLAIN, META);
    const before = readFileSync(local.pathOf(KEY));
    const rotated = new EncryptedDocumentStorage(local, {
      keyring: Keyring.parse(`k1:${K1},k2:${K2}`, 'k2'),
      requireEncrypted: true,
    });
    // Still readable with the old key in the ring.
    expect(Buffer.from(await rotated.get(KEY, META))).toEqual(Buffer.from(PLAIN));
    expect(await rotated.rewrapExisting(KEY)).toBe(true);
    expect(await rotated.rewrapExisting(KEY)).toBe(false);
    const after = readFileSync(local.pathOf(KEY));
    expect(sealedKeyId(after)).toBe('k2');
    // Only the small wrapped key changed: the document's ciphertext is the same.
    expect(
      after
        .subarray(after.length - PLAIN.length)
        .equals(before.subarray(before.length - PLAIN.length)),
    ).toBe(true);
    // The old key can now be removed from the ring.
    const onlyNew = new EncryptedDocumentStorage(local, {
      keyring: Keyring.parse(`k2:${K2}`, 'k2'),
      requireEncrypted: true,
    });
    expect(Buffer.from(await onlyNew.get(KEY, META))).toEqual(Buffer.from(PLAIN));
    expect(rewrap(Keyring.parse(`k2:${K2}`, 'k2'), KEY, after)).toBeNull();
  });

  it('no plaintext file is left behind by a write, and none is created by a read', async () => {
    const { dir, enc } = stores();
    await enc.put(KEY, PLAIN, META);
    await enc.get(KEY, META);
    const files = readdirSync(join(dir, 'uploads'), { recursive: true }).map(String);
    expect(files).toEqual([KEY]);
  });
});

describe('the keyring', () => {
  it('parses id:key pairs and refuses anything malformed, naming ids only', () => {
    expect(Keyring.parse(`a:${K1}, b:${K2}`, 'b').ids).toEqual(['a', 'b']);
    const bad: [string, string][] = [
      ['', 'k1'],
      [`k1:${K1}`, 'k2'],
      [`k1:${K1},k1:${K2}`, 'k1'],
      ['k1:c2hvcnQ=', 'k1'],
      [`../x:${K1}`, '../x'],
      [K1, 'k1'],
    ];
    for (const [keys, active] of bad) {
      let message = '';
      try {
        Keyring.parse(keys, active);
      } catch (e) {
        expect(e).toBeInstanceOf(KeyringError);
        message = (e as Error).message;
      }
      expect(message, keys).not.toBe('');
      expect(message).not.toContain(K1);
      expect(message).not.toContain(K2);
    }
  });
});

describe('configuration: production requires encryption at rest', () => {
  const base = {
    NODE_ENV: 'production',
    VEYRA_ENV: 'production',
    DATABASE_URL: 'postgres://veyra@db.example.com/veyra?sslmode=verify-full',
    VEYRA_DATA_DIR: '/var/lib/veyra',
    VEYRA_ERP: 'fake',
    VEYRA_PUBLIC_ORIGIN: 'https://client.example.com',
    VEYRA_ORGANIZATION_NAME: 'Made-up Client',
  };
  const load = (env: Record<string, string>) => loadConfig(env, { dataDir: '/var/lib/veyra' });
  const problems = (env: Record<string, string>) => {
    try {
      load(env);
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };

  it('refuses to start without data keys, and with a malformed or unknown active key', () => {
    expect(problems(base)).toMatch(/VEYRA_DATA_KEYS and VEYRA_DATA_KEY_ACTIVE are required/);
    expect(problems({ ...base, VEYRA_DATA_KEYS: `k1:${K1}`, VEYRA_DATA_KEY_ACTIVE: 'k9' })).toMatch(
      /VEYRA_DATA_KEY_ACTIVE/,
    );
    const msg = problems({ ...base, VEYRA_DATA_KEYS: `k1:${K1}`, VEYRA_DATA_KEY_ACTIVE: 'k9' });
    expect(msg).not.toContain(K1);
  });

  it('with keys, storage is encrypted, and the logged summary names the key id only', () => {
    const env = { ...base, VEYRA_DATA_KEYS: `k1:${K1}`, VEYRA_DATA_KEY_ACTIVE: 'k1' };
    const config = load(env);
    expect(createStorage(config.storage).kind).toBe('encrypted');
    expect(describeConfig(config).storage).toBe('local+encrypted:k1');
    const lines: string[] = [];
    createLogger(
      { level: 'info', environment: 'production' },
      {
        write: (l: string) => lines.push(l),
      },
    ).info({ config: { storage: config.storage } }, 'config');
    expect(lines.join('')).not.toContain(K1);
  });
});
