import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageConfig } from '../config';
import { amzDate, sha256Hex, signV4, uriEncode } from './sigv4';
import {
  StorageConfigurationError,
  StorageNotFoundError,
  StorageUnavailableError,
  assertSafeKey,
  verifyChecksum,
  type DocumentStorage,
} from './storage';

type S3Settings = NonNullable<StorageConfig['s3']>;

export interface S3StorageOptions extends S3Settings {
  /** Per-request timeout. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
}

/**
 * Documents in an S3-compatible bucket (AWS S3, DigitalOcean Spaces, MinIO, Cloudflare R2, …),
 * over plain HTTPS with Signature V4: PUT, GET, HEAD and DELETE of single objects. No SDK and no
 * provider-specific features. Objects are private (no ACL is set; the bucket must not be public).
 *
 * Errors are typed and safe: 404 → not found; 401/403 → configuration (never retried);
 * 5xx, 429, network failures and timeouts → unavailable (retryable). Response bodies, URLs and
 * credentials never appear in an error message.
 */
export class S3DocumentStorage implements DocumentStorage {
  readonly kind = 's3' as const;
  readonly #o: Required<Omit<S3StorageOptions, keyof S3Settings>> & S3Settings;

  constructor(options: S3StorageOptions) {
    this.#o = {
      timeoutMs: 30_000,
      fetch: globalThis.fetch,
      clock: () => new Date(),
      ...options,
    };
  }

  #url(key: string | null): URL {
    const { endpoint, bucket, forcePathStyle, prefix } = this.#o;
    const base = new URL(endpoint);
    const objectPath =
      key === null
        ? ''
        : `${prefix}${key}`
            .split('/')
            .map((s) => uriEncode(s))
            .join('/');
    if (forcePathStyle) {
      base.pathname = `/${bucket}/${objectPath}`;
    } else {
      base.hostname = `${bucket}.${base.hostname}`;
      base.pathname = `/${objectPath}`;
    }
    return base;
  }

  async #request(
    method: 'PUT' | 'GET' | 'HEAD' | 'DELETE',
    key: string | null,
    body?: Uint8Array,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    if (key !== null) assertSafeKey(key);
    const url = this.#url(key);
    const payloadHash = sha256Hex(body ?? '');
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-date': amzDate(this.#o.clock()),
      'x-amz-content-sha256': payloadHash,
      ...extra,
    };
    const authorization = signV4({
      method,
      url,
      headers,
      payloadHash,
      region: this.#o.region,
      service: 's3',
      accessKeyId: this.#o.accessKeyId,
      secretAccessKey: this.#o.secretAccessKey,
    });
    let res: Response;
    try {
      // `host` is signed but set by the HTTP client itself.
      const sent = Object.fromEntries(Object.entries(headers).filter(([h]) => h !== 'host'));
      res = await this.#o.fetch(url, {
        method,
        headers: { ...sent, authorization },
        ...(body ? { body: Buffer.from(body) } : {}),
        signal: AbortSignal.timeout(this.#o.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new StorageUnavailableError({ cause: safeCause(error) });
    }
    if (res.ok) return res;
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) throw new StorageNotFoundError();
    if (res.status === 401 || res.status === 403) throw new StorageConfigurationError();
    if (res.status === 400 && key === null) throw new StorageConfigurationError();
    throw new StorageUnavailableError({ cause: new Error(`storage responded ${res.status}`) });
  }

  async put(key: string, bytes: Uint8Array, meta: { mime: string; sha256: string }) {
    await this.#request('PUT', key, bytes, {
      'content-type': meta.mime,
      'x-amz-meta-sha256': meta.sha256,
    });
  }

  async get(key: string, verify?: { sha256: string }): Promise<Uint8Array> {
    const res = await this.#request('GET', key);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (error) {
      throw new StorageUnavailableError({ cause: safeCause(error) });
    }
    return verifyChecksum(bytes, verify);
  }

  async metadata(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const res = await this.#request('HEAD', key);
      return { sizeBytes: Number(res.headers.get('content-length') ?? 0) };
    } catch (error) {
      if (error instanceof StorageNotFoundError) return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.metadata(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#request('DELETE', key);
    } catch (error) {
      if (!(error instanceof StorageNotFoundError)) throw error;
    }
  }

  async withLocalFile<T>(
    key: string,
    fn: (path: string) => Promise<T>,
    verify?: { sha256: string },
  ): Promise<T> {
    const bytes = await this.get(key, verify);
    const dir = await mkdtemp(join(tmpdir(), 'veyra-doc-'));
    const path = join(dir, `${randomBytes(8).toString('hex')}.bin`);
    try {
      await writeFile(path, bytes, { mode: 0o600 });
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Readiness: the bucket answers a signed HEAD with these credentials. */
  async check(): Promise<void> {
    await this.#request('HEAD', null);
  }
}

/** Keeps only the error class and code of a transport failure (never a URL or header). */
function safeCause(error: unknown): Error {
  const name = error instanceof Error ? error.name : 'Error';
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code;
  return new Error(typeof code === 'string' ? `${name} ${code}` : name);
}
