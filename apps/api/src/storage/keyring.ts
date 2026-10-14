import type { Secret } from '../secret';

/**
 * The key-encryption keys (KEKs) for data at rest (docs/SECURITY.md, "Encryption at rest").
 *
 * - Each key has a short id (`k1`, `2026-10`), stored with every value it protects, so old values
 *   stay readable while a new key is introduced (rotation re-wraps, it never strands data).
 * - The active key protects everything written from now on; the others only read.
 * - Keys come from the deployment's secret variables (`VEYRA_DATA_KEYS`, `VEYRA_DATA_KEY_ACTIVE`),
 *   never from the database or the image, and never leave this process: no API, log or error
 *   carries a key, only its id.
 */
export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;

export class Keyring {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly activeId: string;

  private constructor(keys: Map<string, Buffer>, activeId: string) {
    this.#keys = keys;
    this.activeId = activeId;
  }

  /**
   * From `id:base64,id:base64` (each 32 random bytes, `openssl rand -base64 32`) and the id of the
   * key new data is written with. Throws KeyringError (naming ids only) on anything malformed.
   */
  static parse(keys: Secret | string, activeId: string): Keyring {
    const raw = typeof keys === 'string' ? keys : keys.reveal();
    const map = new Map<string, Buffer>();
    for (const entry of raw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)) {
      const at = entry.indexOf(':');
      const id = at > 0 ? entry.slice(0, at) : '';
      if (!ID.test(id))
        throw new KeyringError(
          'VEYRA_DATA_KEYS must be a comma-separated list of id:key (ids: letters, digits, - and _).',
        );
      const key = Buffer.from(entry.slice(at + 1), 'base64');
      if (key.length !== 32)
        throw new KeyringError(
          `VEYRA_DATA_KEYS: key "${id}" must be 32 random bytes, base64-encoded.`,
        );
      if (map.has(id)) throw new KeyringError(`VEYRA_DATA_KEYS: key "${id}" is listed twice.`);
      map.set(id, key);
    }
    if (map.size === 0) throw new KeyringError('VEYRA_DATA_KEYS holds no key.');
    if (!map.has(activeId))
      throw new KeyringError(
        `VEYRA_DATA_KEY_ACTIVE ("${activeId}") must be one of the ids in VEYRA_DATA_KEYS.`,
      );
    return new Keyring(map, activeId);
  }

  /** The key with this id; KeyringError when it is not in the ring (the value cannot be read). */
  key(id: string): Buffer {
    const k = this.#keys.get(id);
    if (!k) throw new KeyringError(`The data key "${id}" is not configured on this Veyrafy.`);
    return k;
  }

  get active(): Buffer {
    return this.key(this.activeId);
  }

  get ids(): string[] {
    return [...this.#keys.keys()];
  }
}
