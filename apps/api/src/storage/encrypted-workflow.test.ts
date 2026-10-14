import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiInvoiceDetail } from '@veyra/shared';
import { eq } from 'drizzle-orm';
import * as t from '../db/schema';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';
import { isSealed } from './encrypted';
import { EncryptedDocumentStorage, Keyring, LocalDocumentStorage } from './index';

/**
 * The whole invoice workflow with documents encrypted at rest: upload, reading, matching,
 * verification and download work exactly as before, while the stored file is ciphertext and no
 * plaintext copy is written anywhere under the data folder. Made-up documents and keys only.
 */

const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
const doc = (file: string) => new Uint8Array(readFileSync(new URL(file, DOCS)));

let app: Awaited<ReturnType<typeof createTestApp>>;
let dir: string;
let local: LocalDocumentStorage;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-encwf-'));
  local = new LocalDocumentStorage(join(dir, 'uploads'));
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
    storage: new EncryptedDocumentStorage(local, {
      keyring: Keyring.parse(`k1:${randomBytes(32).toString('base64')}`, 'k1'),
      requireEncrypted: true,
    }),
  });
  app.runner.stop();
  await app.server.inject({ method: 'POST', url: '/api/v1/dev/reset', payload: { erp: 'demo' } });
  app.runner.stop();
}, 60_000);
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function multipart(filename: string, bytes: Uint8Array) {
  const boundary = '----veyra-enc';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('the invoice workflow with documents encrypted at rest', () => {
  it('reads, checks and verifies a made-up invoice; the stored file is ciphertext; the download is the original', async () => {
    const original = doc('D01-clean-text.pdf');
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart('D01-clean-text.pdf', original),
    });
    expect(res.statusCode, res.body).toBe(201);
    const { invoiceId, documentId } = res.json<{ invoiceId: string; documentId: string }>();
    await app.runner.drain();

    const inv = (
      await app.server.inject({ method: 'GET', url: `/api/v1/invoices/${invoiceId}` })
    ).json<ApiInvoiceDetail>();
    expect(inv.state).toBe('VERIFIED_PENDING_PAYMENT');

    // On disk: only ciphertext, under the document's key, and nothing else (no plaintext copy).
    const [row] = await app.veyra.db
      .select()
      .from(t.documents)
      .where(eq(t.documents.id, documentId));
    const stored = readFileSync(local.pathOf(row?.storagePath ?? ''));
    expect(isSealed(stored)).toBe(true);
    expect(stored.includes(Buffer.from('%PDF'))).toBe(false);
    const files = readdirSync(join(dir, 'uploads'), { recursive: true }).map(String);
    expect(files).toEqual([row?.storagePath]);

    // An authorised download gets the original, byte for byte.
    const file = await app.server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/file`,
    });
    expect(file.statusCode).toBe(200);
    expect(Buffer.compare(file.rawPayload, Buffer.from(original))).toBe(0);
  });

  it('a stored file that was altered is never served or read: a safe error, no content', async () => {
    const original = doc('D07-quantity-mismatch.pdf');
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart('D07-quantity-mismatch.pdf', original),
    });
    const { documentId } = res.json<{ documentId: string }>();
    await app.runner.drain();
    const [row] = await app.veyra.db
      .select()
      .from(t.documents)
      .where(eq(t.documents.id, documentId));
    const path = local.pathOf(row?.storagePath ?? '');
    const bytes = readFileSync(path);
    bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 0xff;
    await local.put(row?.storagePath ?? '', bytes, {
      mime: 'application/octet-stream',
      sha256: (await import('./storage')).sha256Hex(bytes),
    });
    const file = await app.server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/file`,
    });
    expect(file.statusCode).toBe(500);
    expect(file.json()).toMatchObject({ error: { code: 'STORAGE_DECRYPT' } });
    expect(file.rawPayload.includes(Buffer.from('%PDF'))).toBe(false);
  });
});
