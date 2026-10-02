import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageOnlyStripPdf } from '@veyra/extractor';
import type { ApiInvoiceDetail } from '@veyra/shared';
import type { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';

/**
 * Uploads of PDFs with NO text layer, through the real local reader and the unchanged workflow,
 * with no AI reader configured (how a deployment without a key reads). Such a file used to fail
 * at once with "No text could be read from the document."; it must now be read as an image,
 * checked, and only asked about where a value could not be established. Made-up data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-scanned-'));
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    demoBusiness: 'brewery',
    allowFixtureExtractor: false,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
  });
  app.runner.stop();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const B01 = new URL('../../../../fixtures/documents/brewery/B01-clean.pdf', import.meta.url);
const detail = async (id: string) =>
  (
    await app.server.inject({ method: 'GET', url: `/api/v1/invoices/${id}` })
  ).json<ApiInvoiceDetail>();

describe('a PDF without a text layer, read by the local reader', () => {
  it('is read as an image and checked: never "No text could be read"', async () => {
    const bytes = await imageOnlyStripPdf(new Uint8Array(readFileSync(B01)), 1);
    const { invoiceId, documentId } = await app.veyra.upload({ filename: 'scan.pdf', bytes });
    await app.runner.drain();
    const inv = await detail(invoiceId);
    expect(inv.state).not.toBe('FAILED');
    expect(inv.failure).toBeNull();
    expect(inv.supplier.gstin).toBe('29AABCM2468K1Z4');
    expect(inv.number).toBe('MMH/26-27/0412');
    expect(inv.poNumber).toBe('PO-2026-1103');
    expect(inv.lines).toHaveLength(1);
    // Validation ran on what was read: verified, or a question about what was not established.
    expect(['VERIFIED_PENDING_PAYMENT', 'COMMITTING', 'NEEDS_INPUT']).toContain(inv.state);
    if (inv.state === 'NEEDS_INPUT')
      expect(inv.questions.filter((q) => q.status === 'open').length).toBeGreaterThan(0);
    const page = await app.server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/pages/1`,
    });
    expect([page.statusCode, page.headers['content-type']]).toEqual([200, 'image/png']);
  }, 120_000);

  it('only a document with nothing readable on it fails, and says why', async () => {
    const blank = new TextEncoder().encode(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
    );
    const { invoiceId } = await app.veyra.upload({ filename: 'blank.pdf', bytes: blank });
    await app.runner.drain();
    const inv = await detail(invoiceId);
    expect(inv.state).toBe('FAILED');
    expect(inv.failure?.reason).toMatch(/^Veyrafy couldn't read this invoice: .*read as an image/);
    expect(inv.failure?.reason).not.toMatch(/No text could be read/);
  }, 60_000);
});
