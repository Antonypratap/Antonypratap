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
let attached = { invoiceId: '', recordId: '', key: '' };

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

  it('an invoice attached to an ERP export is stored encrypted, never in the database, and still checks', async () => {
    const pdf = doc('D12-missing-receipt.pdf');
    const exported = {
      data: [
        {
          success: true,
          invoice_info: {
            grn_id: '9101',
            grn_no: '501',
            po_id: '7701',
            dc_no: 'MU/26-27/0042',
            grn_date: '28/09/2026',
            invoice_date: '2026-09-30',
            invoice_amount: 0,
            branch_id: 'BRN0000001',
            vendor_name: 'Made-up Supplies Pvt. Ltd.',
            vendor_code: 'SCM0000001',
          },
          items: [
            {
              item_name: 'Made-up item',
              hsn_sac_code: null,
              uom: 'NOS',
              quantity: '10',
              basic_rate: '10.00',
              basic_amount: 100,
              discount: 0,
              cgst: 0,
              sgst: 0,
              igst: 0,
              freight: 0,
              other_charges: [],
            },
          ],
          images: [
            {
              file_name: 'MU-0042.pdf',
              mime_type: 'application/pdf',
              base64: Buffer.from(pdf).toString('base64'),
            },
          ],
        },
      ],
    };
    const r = await app.veyra.importReceipts('made-up-export.json', exported, app.session.userId);
    expect(r.imported).toBe(1);
    const [row] = await app.veyra.db
      .select()
      .from(t.erpReceiptRecords)
      .where(eq(t.erpReceiptRecords.id, r.records[0]?.id ?? ''));
    expect(row?.attachmentBase64).toBeNull();
    expect(row?.attachmentKey).toBe(`erp-attachments/${row?.id ?? ''}`);
    const stored = readFileSync(local.pathOf(row?.attachmentKey ?? ''));
    expect(isSealed(stored)).toBe(true);
    expect(stored.includes(Buffer.from('%PDF'))).toBe(false);
    // Checking it reads it back from encrypted storage, exactly as attached.
    const { invoiceId } = await app.veyra.checkReceiptAttachment(row?.id ?? '', app.session.userId);
    const [d] = await app.veyra.db.select().from(t.invoices).where(eq(t.invoices.id, invoiceId));
    const [document] = await app.veyra.db
      .select()
      .from(t.documents)
      .where(eq(t.documents.id, d?.documentId ?? ''));
    expect(document?.sha256).toBe(row?.attachmentSha256);
    attached = { invoiceId, recordId: row?.id ?? '', key: row?.attachmentKey ?? '' };
  });

  it('deleting the original removes every copy and the text read from it; the checks stay as they were', async () => {
    await app.runner.drain();
    const view = async () => {
      const d = (
        await app.server.inject({ method: 'GET', url: `/api/v1/invoices/${attached.invoiceId}` })
      ).json<ApiInvoiceDetail>();
      return {
        state: d.state,
        verdict: d.comparison?.verdict ?? null,
        rows: (d.comparison?.rows ?? []).map((r) => [r.label, r.invoice, r.erp, r.result]),
      };
    };
    const before = await view();
    const [inv] = await app.veyra.db
      .select()
      .from(t.invoices)
      .where(eq(t.invoices.id, attached.invoiceId));
    const [document] = await app.veyra.db
      .select()
      .from(t.documents)
      .where(eq(t.documents.id, inv?.documentId ?? ''));

    expect(await app.veyra.deleteDocument(attached.invoiceId, app.session.userId)).toBe(true);

    // Both stored files are gone: the uploaded original and the ERP record's attached copy.
    expect(await local.exists(document?.storagePath ?? '')).toBe(false);
    expect(await local.exists(attached.key)).toBe(false);
    const [record] = await app.veyra.db
      .select()
      .from(t.erpReceiptRecords)
      .where(eq(t.erpReceiptRecords.id, attached.recordId));
    expect(record).toMatchObject({
      attachmentKey: null,
      attachmentSha256: null,
      attachmentBase64: null,
    });
    // The text read from it: no other printed values (beyond freight) and no quoted evidence.
    for (const x of await app.veyra.db
      .select()
      .from(t.extractions)
      .where(eq(t.extractions.invoiceId, attached.invoiceId))) {
      const raw = JSON.parse(x.rawJson) as {
        contentsRemoved?: boolean;
        otherFields?: { label: string }[];
      };
      expect(raw.contentsRemoved).toBe(true);
      expect(
        (raw.otherFields ?? []).every((o) => /freight|cartage|carriage|transport/i.test(o.label)),
      ).toBe(true);
      expect(x.rawJson).not.toMatch(/"text":"[^"]/);
    }
    for (const f of await app.veyra.db
      .select()
      .from(t.extractedFields)
      .where(eq(t.extractedFields.invoiceId, attached.invoiceId)))
      expect(f.evidenceJson ?? '').not.toMatch(/"text":"[^"]/);
    // The invoice, its checks and its decision are exactly as before.
    expect(await view()).toEqual(before);
    // The audit says what went, as counts only.
    const [audit] = await app.veyra.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.event, 'document.deleted'));
    expect(JSON.parse(audit?.detailJson ?? '{}')).toMatchObject({
      removed: { original: 1, erpAttachmentCopies: 1 },
    });
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
