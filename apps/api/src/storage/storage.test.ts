import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidStorageKeyError,
  LocalDocumentStorage,
  S3DocumentStorage,
  StorageConfigurationError,
  StorageIntegrityError,
  StorageNotFoundError,
  StorageUnavailableError,
  assertSafeKey,
  sha256Hex,
  type DocumentStorage,
} from './index';
import { amzDate, signV4, sha256Hex as hashHex } from './sigv4';

const PDF = new TextEncoder().encode('%PDF-1.4 test document %%EOF');
const META = { mime: 'application/pdf', sha256: sha256Hex(PDF) };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

function localStorage(): LocalDocumentStorage {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-storage-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return new LocalDocumentStorage(join(dir, 'uploads'));
}

/** A minimal S3-compatible server: checks every request's SigV4 signature, keeps objects in memory. */
async function fakeS3(opts: { failWith?: number } = {}) {
  const objects = new Map<string, { body: Buffer; type: string; meta: string }>();
  const seen: { method: string; path: string; authorization: string }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const authorization = String(req.headers.authorization ?? '');
      seen.push({ method: req.method ?? '', path: url.pathname, authorization });
      const signed = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(';') ?? [];
      const expected = signV4({
        method: req.method ?? '',
        url,
        headers: Object.fromEntries(signed.map((h) => [h, String(req.headers[h] ?? '')])),
        payloadHash: String(req.headers['x-amz-content-sha256']),
        region: 'eu-west-1',
        service: 's3',
        accessKeyId: 'AKIDTEST',
        secretAccessKey: 'test-secret',
      });
      if (
        authorization !== expected ||
        String(req.headers['x-amz-content-sha256']) !== hashHex(body)
      ) {
        res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        return;
      }
      if (opts.failWith) {
        res.writeHead(opts.failWith).end('<Error>internal detail</Error>');
        return;
      }
      if (url.pathname === '/veyra-docs/' || url.pathname === '/veyra-docs') {
        res.writeHead(200).end();
        return;
      }
      const key = decodeURIComponent(url.pathname.replace(/^\/veyra-docs\//, ''));
      const o = objects.get(key);
      switch (req.method) {
        case 'PUT':
          objects.set(key, {
            body,
            type: String(req.headers['content-type']),
            meta: String(req.headers['x-amz-meta-sha256']),
          });
          res.writeHead(200).end();
          return;
        case 'GET':
        case 'HEAD':
          if (!o) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { 'content-length': String(o.body.length) });
          res.end(req.method === 'GET' ? o.body : undefined);
          return;
        case 'DELETE':
          objects.delete(key);
          res.writeHead(204).end();
          return;
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as { port: number }).port;
  const storage = (secret = 'test-secret') =>
    new S3DocumentStorage({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'eu-west-1',
      bucket: 'veyra-docs',
      accessKeyId: 'AKIDTEST',
      secretAccessKey: secret,
      forcePathStyle: true,
      prefix: 'veyra/',
    });
  return { objects, seen, storage };
}

async function contract(storage: DocumentStorage) {
  const key = '01K0000000000000000000ABCD.pdf';
  expect(await storage.exists(key)).toBe(false);
  expect(await storage.metadata(key)).toBeNull();
  await storage.put(key, PDF, META);
  expect(await storage.exists(key)).toBe(true);
  expect(await storage.metadata(key)).toEqual({ sizeBytes: PDF.length });
  expect(Buffer.from(await storage.get(key, { sha256: META.sha256 }))).toEqual(Buffer.from(PDF));
  await expect(storage.get(key, { sha256: '0'.repeat(64) })).rejects.toBeInstanceOf(
    StorageIntegrityError,
  );
  const seen = await storage.withLocalFile(
    key,
    async (path) => readdirSync(join(path, '..')),
    META,
  );
  expect(seen.length).toBeGreaterThan(0);
  await expect(storage.get('01K0000000000000000000ZZZZ.pdf')).rejects.toBeInstanceOf(
    StorageNotFoundError,
  );
  await storage.put('imports/01K00000000000000000000001/1-Vendors (1).xlsx', PDF, META);
  expect(await storage.exists('imports/01K00000000000000000000001/1-Vendors (1).xlsx')).toBe(true);
  await storage.delete(key);
  expect(await storage.exists(key)).toBe(false);
  await storage.check();
}

describe('document storage (Phase 6)', () => {
  it('keys cannot escape the store: no traversal, absolute paths, hidden files or odd bytes', () => {
    for (const bad of [
      '../etc/passwd',
      'a/../../b',
      '/etc/passwd',
      '..',
      '.hidden',
      'a\\b',
      'a\u0000b',
      '',
      'a//b',
      'x/'.repeat(5) + 'y',
      'imports/..%2f/x',
      'C:\\temp\\x',
    ])
      expect(() => assertSafeKey(bad), bad).toThrow(InvalidStorageKeyError);
    expect(() => assertSafeKey('01K0000000000000000000ABCD.pdf')).not.toThrow();
  });

  it('local: store, retrieve, checksum, metadata, missing file, delete', async () => {
    await contract(localStorage());
  });

  it('local: a write is atomic (no partial file under the real key) and stays inside the root', async () => {
    const s = localStorage();
    await s.put('01K0000000000000000000ABCD.pdf', PDF, META);
    expect(readdirSync(s.root)).toEqual(['01K0000000000000000000ABCD.pdf']);
    await expect(s.put('../outside.pdf', PDF, META)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    expect(() => s.pathOf('../../x')).toThrow(InvalidStorageKeyError);
  });

  it('local: a document altered on disk is detected, never used', async () => {
    const s = localStorage();
    await s.put('01K0000000000000000000ABCD.pdf', PDF, META);
    writeFileSync(s.pathOf('01K0000000000000000000ABCD.pdf'), 'tampered');
    await expect(
      s.withLocalFile('01K0000000000000000000ABCD.pdf', async () => 'read', META),
    ).rejects.toBeInstanceOf(StorageIntegrityError);
  });

  it('s3-compatible: the same contract, every request signed (SigV4), objects private', async () => {
    const s3 = await fakeS3();
    await contract(s3.storage());
    expect(
      s3.seen.every((r) => r.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIDTEST/')),
    ).toBe(true);
    expect(
      s3.seen.some(
        (r) =>
          r.path ===
          '/veyra-docs/veyra/imports/01K00000000000000000000001/1-Vendors%20%281%29.xlsx',
      ),
    ).toBe(true);
    expect(
      s3.objects.get('veyra/imports/01K00000000000000000000001/1-Vendors (1).xlsx'),
    ).toMatchObject({
      meta: META.sha256,
    });
  });

  it('s3-compatible: a temporary copy for reading is removed afterwards', async () => {
    const s3 = await fakeS3();
    const s = s3.storage();
    await s.put('01K0000000000000000000ABCD.pdf', PDF, META);
    let copy = '';
    await s.withLocalFile(
      '01K0000000000000000000ABCD.pdf',
      async (p) => {
        copy = p;
      },
      META,
    );
    expect(() => readdirSync(join(copy, '..'))).toThrow();
  });

  it('s3-compatible: wrong credentials are a configuration error; 5xx and network are retryable', async () => {
    const good = await fakeS3();
    await expect(good.storage('wrong-secret').check()).rejects.toBeInstanceOf(
      StorageConfigurationError,
    );
    const down = await fakeS3({ failWith: 503 });
    const e = await down
      .storage()
      .get('01K0000000000000000000ABCD.pdf')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StorageUnavailableError);
    expect(e).toMatchObject({ retryable: true });
    const unreachable = new S3DocumentStorage({
      endpoint: 'http://127.0.0.1:9',
      region: 'eu-west-1',
      bucket: 'veyra-docs',
      accessKeyId: 'AKIDTEST',
      secretAccessKey: 'test-secret',
      forcePathStyle: true,
      prefix: '',
    });
    const n = await unreachable.check().catch((x: unknown) => x);
    expect(n).toBeInstanceOf(StorageUnavailableError);
    expect(`${(n as Error).message} ${String((n as Error).cause)}`).not.toMatch(
      /127\.0\.0\.1|test-secret|AKIDTEST|veyra-docs/,
    );
  });

  it('SigV4 matches the AWS reference vector (get-vanilla)', () => {
    expect(amzDate(new Date('2015-08-30T12:36:00Z'))).toBe('20150830T123600Z');
    expect(
      signV4({
        method: 'GET',
        url: new URL('https://example.amazonaws.com/'),
        headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
        payloadHash: hashHex(''),
        region: 'us-east-1',
        service: 'service',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      }),
    ).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});
