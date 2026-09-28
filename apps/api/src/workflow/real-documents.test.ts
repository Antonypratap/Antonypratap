import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BUYER, DOCUMENT_SAMPLES, renderScenario, scenarioById } from '@veyra/extractor';
import type { ApiInvoiceDetail, ApiQuestion } from '@veyra/shared';
import { eq } from 'drizzle-orm';
import { createApp } from '../app';
import * as t from '../db/schema';
import { DEMO_NOW } from '../test/harness';

/**
 * Phase 3D proof: real documents (fixtures/documents) through the real local extractor (pdf.js
 * text layer, Tesseract OCR) and the unchanged deterministic workflow, end to end.
 */
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;
const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
const IMPORTS = new URL('../../../../fixtures/imports/', import.meta.url);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-docs-'));
  app = await createApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
  });
  app.runner.stop();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await app.server.inject({ method: 'POST', url: '/api/v1/dev/reset', payload: { erp: 'demo' } });
  app.runner.stop();
});

function multipart(filename: string, bytes: Uint8Array) {
  const boundary = '----veyra-docs';
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
const get = async <T>(url: string): Promise<T> =>
  (await app.server.inject({ method: 'GET', url })).json<T>();
const doc = (file: string) => new Uint8Array(readFileSync(new URL(file, DOCS)));

async function uploadBytes(filename: string, bytes: Uint8Array) {
  return app.server.inject({
    method: 'POST',
    url: '/api/v1/documents',
    ...multipart(filename, bytes),
  });
}
async function upload(file: string): Promise<{ invoiceId: string; documentId: string }> {
  const res = await uploadBytes(file, doc(file));
  expect(res.statusCode, res.body).toBe(201);
  const created = res.json<{ invoiceId: string; documentId: string }>();
  // Processing is a background job: the upload itself only stores and queues.
  expect(app.veyra.invoiceRow(app.veyra.db, created.invoiceId).state).toBe('UPLOADED');
  await app.runner.drain();
  return created;
}
const detail = (id: string) => get<ApiInvoiceDetail>(`/api/v1/invoices/${id}`);
const openQuestion = async (invoiceId: string) =>
  (await get<ApiQuestion[]>('/api/v1/questions')).find((q) => q.invoiceId === invoiceId) ?? null;
async function answer(q: ApiQuestion, optionId: string, input?: unknown) {
  const res = await app.server.inject({
    method: 'POST',
    url: `/api/v1/questions/${q.id}/answer`,
    payload: { optionId, ...(input === undefined ? {} : { input }) },
  });
  expect(res.statusCode, res.body).toBe(200);
  await app.runner.drain();
}

/** What the designated user would type for a field, from what the document really prints. */
function truthFor(file: string, path: string): string | null {
  const sample = DOCUMENT_SAMPLES.find((s) => s.file === file);
  const inv = sample?.invoices[0];
  if (!inv) return null;
  const header: Record<string, string | null | undefined> = {
    vendorName: inv.vendor.name,
    vendorGstin: inv.vendor.gstin,
    buyerGstin: BUYER.gstin,
    invoiceNumber: inv.number,
    invoiceDate: inv.date,
    poNumber: inv.po,
    placeOfSupply: inv.placeOfSupply,
    taxablePaise: inv.taxable,
    cgstPaise: inv.cgst,
    sgstPaise: inv.sgst,
    igstPaise: inv.igst,
    totalPaise: inv.total,
  };
  const h = /^header\.(\w+)$/.exec(path);
  if (h) return header[h[1] ?? ''] ?? null;
  const l = /^lines\[(\d+)\]\.(\w+)$/.exec(path);
  const line = inv.lines[Number(l?.[1]) - 1];
  if (!line) return null;
  const byKey: Record<string, string | undefined> = {
    description: line.description,
    hsnSac: line.hsn,
    qtyMilli: line.qty,
    uom: line.uom,
    unitPricePaise: line.rate,
    taxablePaise: line.taxable,
    gstRateBp: line.gst,
  };
  return byKey[l?.[2] ?? ''] ?? null;
}

const SUPPLIER_CODE: Record<string, string> = {
  'D02-scanned.pdf': 'V002',
  'D03-photo.jpg': 'V004',
  'D04-photo.png': 'V001',
  'D09-ambiguous-vendor.pdf': 'V005',
};

/**
 * Plays the designated user: answers each unclear or missing field with what the document really
 * prints (never with anything else), and picks the supplier when asked. Returns the question codes.
 */
async function answerAsUser(file: string, invoiceId: string): Promise<string[]> {
  const asked: string[] = [];
  for (let i = 0; i < 25; i++) {
    if ((await detail(invoiceId)).state !== 'NEEDS_INPUT') break;
    const q = await openQuestion(invoiceId);
    if (!q) throw new Error('NEEDS_INPUT without an open question');
    asked.push(`${q.code}:${q.paths.join(',')}`);
    if (q.code === 'MD_FIELD') {
      const path = q.paths[0] ?? '';
      const value = truthFor(file, path);
      if (value === null) throw new Error(`No printed value for ${path}`);
      await answer(q, `set:${path}`, value);
    } else if (q.code === 'AM_VENDOR') {
      // The user knows who sent the invoice: the supplier printed on it (DEMO.md §1.3 codes).
      await answer(q, `vendor:${SUPPLIER_CODE[file] ?? 'unknown'}`);
    } else {
      throw new Error(`Unexpected question ${q.code} (${q.summary})`);
    }
  }
  return asked;
}

describe('real documents through the real pipeline', () => {
  it('clean text PDF: document → extraction → ERP matching → validation → commit → VERIFIED_PENDING_PAYMENT, with no questions', async () => {
    const { invoiceId, documentId } = await upload('D01-clean-text.pdf');
    const inv = await detail(invoiceId);
    expect(inv).toMatchObject({ state: 'VERIFIED_PENDING_PAYMENT', status: 'handled' });
    expect(await openQuestion(invoiceId)).toBeNull();
    expect(inv.checks.every((c) => c.outcome === 'pass' || c.outcome === 'not_applicable')).toBe(
      true,
    );
    const [recorded] = await app.veyra.erp.listPurchaseInvoices();
    expect(recorded).toMatchObject({
      vendorInvoiceNo: 'SSS/26-27/0501',
      status: 'verified_pending_payment',
    });

    // The original is kept byte for byte, and how it was read is observable.
    const file = await app.server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/file`,
    });
    expect(Buffer.compare(file.rawPayload, Buffer.from(doc('D01-clean-text.pdf')))).toBe(0);
    expect(await get(`/api/v1/documents/${documentId}`)).toMatchObject({
      filename: 'D01-clean-text.pdf',
      mime: 'application/pdf',
      sizeBytes: doc('D01-clean-text.pdf').length,
      state: 'VERIFIED_PENDING_PAYMENT',
      extraction: { extractor: 'local_ocr', pages: 1, methods: ['pdf_text'] },
    });
    const audit = await get<{ title: string; detail: string; by: string }[]>(
      `/api/v1/audit?invoiceId=${invoiceId}`,
    );
    expect(audit.find((a) => a.title === 'Invoice understood')?.detail).toMatch(
      /^Read from the PDF's text\./,
    );
  });

  it('exception: unreadable total → NEEDS_INPUT → user answer → re-evaluation → commit → VERIFIED_PENDING_PAYMENT', async () => {
    const { invoiceId } = await upload('D06-unreadable-total.pdf');
    expect((await detail(invoiceId)).state).toBe('NEEDS_INPUT');
    const q = await openQuestion(invoiceId);
    expect(q).toMatchObject({ code: 'MD_FIELD', paths: ['header.totalPaise'] });
    await answer(q as ApiQuestion, 'set:header.totalPaise', '13,275.00');
    expect(await detail(invoiceId)).toMatchObject({
      state: 'VERIFIED_PENDING_PAYMENT',
      status: 'ready',
    });
    const [recorded] = await app.veyra.erp.listPurchaseInvoices();
    expect(recorded).toMatchObject({ vendorInvoiceNo: 'SSS/26-27/0515' });
  });

  for (const [file, method] of [
    ['D02-scanned.pdf', 'tesseract'],
    ['D03-photo.jpg', 'tesseract'],
    ['D04-photo.png', 'tesseract'],
  ] as const) {
    it(`${file}: OCR; anything unclear is asked; answered with what is printed → VERIFIED_PENDING_PAYMENT`, async () => {
      const { invoiceId, documentId } = await upload(file);
      expect((await detail(invoiceId)).state).toBe('NEEDS_INPUT');
      const asked = await answerAsUser(file, invoiceId);
      expect(asked.length).toBeGreaterThan(0);
      // Only reading questions: unclear fields and, when the GSTIN was unclear, which supplier.
      expect(asked.every((a) => /^(MD_FIELD|AM_VENDOR):/.test(a))).toBe(true);
      expect(asked).toContain('MD_FIELD:header.buyerGstin'); // misread by OCR: asked, not used
      expect((await detail(invoiceId)).state).toBe('VERIFIED_PENDING_PAYMENT');
      expect(
        (await get<{ extraction: { methods: string[] } }>(`/api/v1/documents/${documentId}`))
          .extraction.methods,
      ).toContain(method);
    }, 60_000);
  }

  it('blurry photo: nothing unclear is used; it waits for the user and is REJECTED only when rejected', async () => {
    const { invoiceId } = await upload('D05-blurry.jpg');
    expect((await detail(invoiceId)).state).toBe('NEEDS_INPUT');
    const q = await openQuestion(invoiceId);
    expect(q?.code).toBe('MD_FIELD');
    await app.runner.drain();
    expect((await detail(invoiceId)).state).toBe('NEEDS_INPUT');
    await answer(q as ApiQuestion, 'reject');
    expect((await detail(invoiceId)).state).toBe('REJECTED');
    expect(await app.veyra.erp.listPurchaseInvoices()).toEqual([]);
  }, 60_000);

  it.each([
    ['D07-quantity-mismatch.pdf', 'VF_R23'],
    ['D08-rate-mismatch.pdf', 'VF_R21'],
  ])('%s: deterministic validation asks %s; no override exists', async (file, code) => {
    const { invoiceId } = await upload(file);
    const q = await openQuestion(invoiceId);
    expect(q?.code).toBe(code);
    expect(q?.options.map((o) => o.id)).not.toContain('override');
    expect(q?.options.some((o) => /override|ignore|continue anyway/i.test(o.label))).toBe(false);
  });

  it('ambiguous vendor (no GSTIN printed, two suppliers share the name) is asked, then verified', async () => {
    const { invoiceId } = await upload('D09-ambiguous-vendor.pdf');
    const q = await openQuestion(invoiceId);
    expect(q?.code).toBe('AM_VENDOR');
    expect(q?.options.map((o) => o.id)).toEqual(
      expect.arrayContaining(['vendor:V005', 'vendor:V006']),
    );
    await answer(q as ApiQuestion, 'vendor:V005');
    expect((await detail(invoiceId)).state).toBe('VERIFIED_PENDING_PAYMENT');
  });

  it('multi-page PDF: one invoice read across two pages and verified', async () => {
    const { invoiceId } = await upload('D10-multi-page.pdf');
    expect(await detail(invoiceId)).toMatchObject({ state: 'VERIFIED_PENDING_PAYMENT' });
  });

  it('two invoices in one file: FAILED with the reason, reprocessable, never merged; rejected only explicitly', async () => {
    const { invoiceId } = await upload('D11-two-invoices.pdf');
    const row = app.veyra.invoiceRow(app.veyra.db, invoiceId);
    expect(row).toMatchObject({ state: 'FAILED', failedStage: 'EXTRACTING' });
    expect(row.failureReason).toMatch(/more than one invoice/);
    const again = await app.server.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/reprocess`,
    });
    expect(again.statusCode).toBe(200);
    await app.runner.drain();
    expect((await detail(invoiceId)).state).toBe('FAILED');
    const rejected = await app.server.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/reject`,
      payload: { reason: 'Two invoices in one file' },
    });
    expect(rejected.statusCode).toBe(200);
    expect((await detail(invoiceId)).state).toBe('REJECTED');
    expect(await app.veyra.erp.listPurchaseInvoices()).toEqual([]);
  });

  it('demo sample invoices keep their scripted reading (S01/S08 unchanged); real documents do not', async () => {
    const s01 = scenarioById('S01');
    if (!s01) throw new Error('S01');
    const res = await uploadBytes(s01.file, renderScenario(s01));
    await app.runner.drain();
    const { invoiceId } = res.json<{ invoiceId: string }>();
    expect((await detail(invoiceId)).status).toBe('handled');
    const x = app.veyra.db
      .select({ extractorId: t.extractions.extractorId })
      .from(t.extractions)
      .where(eq(t.extractions.invoiceId, invoiceId))
      .get();
    expect(x?.extractorId).toBe('fixture');
  });

  it('idempotent: running the pipeline again after commit writes nothing new', async () => {
    const { invoiceId } = await upload('D01-clean-text.pdf');
    await app.veyra.runPipeline(invoiceId);
    await app.runner.drain();
    expect(await app.veyra.erp.listPurchaseInvoices()).toHaveLength(1);
    expect((await detail(invoiceId)).state).toBe('VERIFIED_PENDING_PAYMENT');
  });
});

describe('document upload safety', () => {
  it('refuses a file that is not a PDF, JPEG or PNG, whatever its name says', async () => {
    const res = await uploadBytes('invoice.pdf', new TextEncoder().encode('MZ\x90\x00 not a pdf'));
    expect(res.statusCode).toBe(415);
    expect(await get<unknown[]>('/api/v1/documents')).toEqual([]);
  });

  it('refuses a truncated PDF and an image whose header is unreadable or too large', async () => {
    const pdf = doc('D01-clean-text.pdf');
    expect((await uploadBytes('cut.pdf', pdf.subarray(0, pdf.length / 2))).statusCode).toBe(415);
    const png = new Uint8Array(40);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 60_000);
    new DataView(png.buffer).setUint32(20, 60_000);
    const huge = await uploadBytes('huge.png', png);
    expect(huge.statusCode).toBe(415);
    expect(huge.json<{ error: { message: string } }>().error.message).toMatch(/pixels/);
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0x00, 0x01);
    expect((await uploadBytes('broken.jpg', jpeg)).statusCode).toBe(415);
  });

  it('refuses an oversized file', async () => {
    const big = new Uint8Array(21 * 1024 * 1024);
    big.set(new TextEncoder().encode('%PDF-1.4\n'));
    const res = await uploadBytes('big.pdf', big);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(await get<unknown[]>('/api/v1/documents')).toEqual([]);
  });

  it('a malformed PDF that passes the upload check fails visibly at extraction', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Garbage >>\ntrailer\n%%EOF\n');
    const res = await uploadBytes('damaged.pdf', bytes);
    const { invoiceId } = res.json<{ invoiceId: string }>();
    await app.runner.drain();
    expect(app.veyra.invoiceRow(app.veyra.db, invoiceId)).toMatchObject({
      state: 'FAILED',
      failedStage: 'EXTRACTING',
    });
  });

  it('a hostile filename is neutralised; the file is stored under the data directory by id', async () => {
    const res = await uploadBytes('../../../etc/passwd.pdf', doc('D01-clean-text.pdf'));
    const { documentId } = res.json<{ documentId: string }>();
    const row = app.veyra.db.select().from(t.documents).where(eq(t.documents.id, documentId)).get();
    expect(row?.filename).toBe('passwd.pdf');
    expect(resolve(row?.storagePath ?? '').startsWith(resolve(dir))).toBe(true);
    expect(row?.storagePath).toContain(documentId);
  });

  it('the same file twice is refused as a duplicate upload', async () => {
    await upload('D01-clean-text.pdf');
    expect((await uploadBytes('again.pdf', doc('D01-clean-text.pdf'))).statusCode).toBe(409);
  });
});

describe('empty business → Excel import → real invoice', () => {
  it('imports the business records from Excel, then verifies a real PDF against them', async () => {
    await app.server.inject({
      method: 'POST',
      url: '/api/v1/dev/reset',
      payload: { erp: 'empty' },
    });
    app.runner.stop();
    for (const file of [
      'Demo-1-Vendors.xlsx',
      'Demo-2-Items.xlsx',
      'Demo-3-PurchaseOrders.xlsx',
      'Demo-4-GoodsReceipts.xlsx',
    ]) {
      const checked = await app.server.inject({
        method: 'POST',
        url: '/api/v1/imports',
        ...multipart(file, readFileSync(new URL(file, IMPORTS))),
      });
      const { id } = checked.json<{ id: string }>();
      const done = await app.server.inject({
        method: 'POST',
        url: `/api/v1/imports/${id}/confirm`,
      });
      expect(done.statusCode, done.body).toBe(200);
    }
    const { invoiceId } = await upload('D01-clean-text.pdf');
    expect((await detail(invoiceId)).state).toBe('VERIFIED_PENDING_PAYMENT');
    const [recorded] = await app.veyra.erp.listPurchaseInvoices();
    const po = await app.veyra.erp.getPurchaseOrder(recorded?.poId as never);
    expect(po).toMatchObject({ poNumber: 'PO-2026-0110', origin: 'imported' });
  });
});
