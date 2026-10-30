import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as t from '../db/schema';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';
import { ApiClients } from './clients';
import type { VerificationView } from './service';

/**
 * The Client Invoice Verification API end to end, through the real local reader (pdf.js and
 * Tesseract), with the repository's synthetic invoices and made-up reference records only.
 */

const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
const doc = (file: string) => new Uint8Array(readFileSync(new URL(file, DOCS)));

/** A made-up reference record in the ERP export shape, for the synthetic invoice D01. */
function reference(over: { rate?: string; qty?: string; amount?: string; total?: number } = {}) {
  const rate = over.rate ?? '62.50';
  const amount = over.amount ?? '6250.00';
  const tax = ((Number(amount) * 9) / 100).toFixed(2);
  return {
    data: [
      {
        invoice_info: {
          grn_id: '9001',
          grn_no: '501',
          po_id: '7701',
          dc_no: 'SSS/26-27/0501',
          grn_date: '28/09/2026',
          invoice_date: '2026-09-27',
          invoice_amount: over.total ?? 7375,
          vendor_name: 'Shakti Steel Suppliers Pvt Ltd',
          vendor_code: 'V-1',
        },
        items: [
          {
            item_name: 'MS Steel Rod 12mm',
            hsn_sac_code: '7214',
            uom: 'KGS',
            quantity: over.qty ?? '100',
            basic_rate: rate,
            basic_amount: amount,
            other_charges: [
              { code: 'GTC0000001', value: tax },
              { code: 'GTC0000002', value: tax },
            ],
          },
        ],
        // A client may send its attachments too: they are ignored, never stored.
        images: [{ file_name: 'x.pdf', mime_type: 'application/pdf', base64: 'bWFkZS11cA==' }],
      },
    ],
  };
}

let app: Awaited<ReturnType<typeof createTestApp>>;
let dir: string;
let keyA = '';
let keyB = '';
let revokedKey = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-verify-'));
  app = await createTestApp({
    dataDir: dir,
    demo: false,
    allowFixtureExtractor: false,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
    verifyApi: true,
    limits: {
      maxUploadBytes: 512 * 1024,
      maxJsonBodyBytes: 1024 * 1024,
      maxPdfPages: 20,
      maxImageSide: 12_000,
      maxImagePixels: 40_000_000,
    },
  });
  app.runner.stop();
  const clients = new ApiClients(app.veyra.db, () => app.veyra.now());
  keyA = (await clients.create('Made-up ERP Partner A')).key;
  keyB = (await clients.create('Made-up ERP Partner B')).key;
  const revoked = await clients.create('Made-up Revoked Partner');
  revokedKey = revoked.key;
  await clients.revoke(revoked.id);
}, 60_000);
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function form(parts: { name: string; value: string | Uint8Array; filename?: string }[]) {
  const boundary = '----veyra-verify-test';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\n${p.filename ? 'Content-Type: application/octet-stream\r\n' : ''}\r\n`,
      ),
      Buffer.from(p.value),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function submit(
  o: {
    key?: string | null;
    file?: string | Uint8Array | null;
    reference?: unknown;
    referenceId?: string | null;
    idempotencyKey?: string;
  } = {},
) {
  const parts: { name: string; value: string | Uint8Array; filename?: string }[] = [];
  if (o.referenceId !== null)
    parts.push({ name: 'reference_id', value: o.referenceId ?? 'PO-7701/INV-501' });
  if (o.reference !== undefined || !('reference' in o))
    parts.push({
      name: 'reference_json',
      value:
        typeof o.reference === 'string' ? o.reference : JSON.stringify(o.reference ?? reference()),
    });
  const file = o.file === undefined ? 'D01-clean-text.pdf' : o.file;
  if (file !== null)
    parts.push({
      name: 'invoice',
      filename: 'invoice.pdf',
      value: typeof file === 'string' ? doc(file) : file,
    });
  const f = form(parts);
  return app.anonymous({
    method: 'POST',
    url: '/api/v1/verify',
    payload: f.payload,
    headers: {
      ...f.headers,
      ...(o.key === null ? {} : { authorization: `Bearer ${o.key ?? keyA}` }),
      ...(o.idempotencyKey ? { 'idempotency-key': o.idempotencyKey } : {}),
    },
  });
}
const get = (id: string, key = keyA) =>
  app.anonymous({
    method: 'GET',
    url: `/api/v1/verification/${id}`,
    headers: { authorization: `Bearer ${key}` },
  });
async function verified(o: Parameters<typeof submit>[0] = {}): Promise<VerificationView> {
  const res = await submit(o);
  expect([200, 202], res.body).toContain(res.statusCode);
  await app.runner.drain();
  const view = (await get(res.json<VerificationView>().verification_id)).json<VerificationView>();
  return view;
}

describe('POST /api/v1/verify: outcomes', () => {
  it('PASSED: every value read on the invoice matches the reference; the invoice file is not kept', async () => {
    const res = await submit({ idempotencyKey: 'passed-1' });
    expect(res.statusCode).toBe(202);
    const accepted = res.json<VerificationView>();
    expect(accepted).toMatchObject({
      reference_id: 'PO-7701/INV-501',
      processing_status: 'processing',
      status: null,
    });
    expect(res.headers.location).toBe(`/api/v1/verification/${accepted.verification_id}`);
    await app.runner.drain();
    const v = (await get(accepted.verification_id)).json<VerificationView>();
    expect(v).toMatchObject({
      processing_status: 'completed',
      status: 'PASSED',
      review_required: false,
      scope: 'invoice_vs_reference',
      failed_fields: [],
      unverified_fields: [],
      error: null,
    });
    expect(v.checks.length).toBeGreaterThan(5);
    expect(v.checks.every((c) => c.result === 'passed' || c.result === 'not_compared')).toBe(true);
    // Out of this API's scope: no duplicate search or record lookup is claimed.
    expect(JSON.stringify(v)).not.toMatch(/Not already in Veyrafy|Matched ERP record/);
    // The invoice file is deleted once read; the attachment sent in the reference was never kept.
    const [row] = await app.veyra.db
      .select()
      .from(t.verifications)
      .where(eq(t.verifications.id, v.verification_id));
    expect(row?.storageKey).toBeNull();
    expect(await app.veyra.storage.exists(`verifications/${v.verification_id}`)).toBe(false);
    expect(row?.referenceJson ?? '').not.toContain('bWFkZS11cA');
  });

  it('FAILED: a rate that differs is reported with both values and the difference', async () => {
    const v = await verified({
      reference: reference({ rate: '60.00', amount: '6000.00', total: 7080 }),
      idempotencyKey: 'failed-1',
    });
    expect(v.status).toBe('FAILED');
    const rate = v.failed_fields.find((f) => f.field === 'lines[1].unitPricePaise');
    expect(rate).toMatchObject({
      invoice_value: '₹62.50',
      reference_value: '₹60.00',
      difference: { value: '2.50', unit: 'INR' },
    });
    expect(rate?.reason).toMatch(/differs/i);
    expect(v.failed_fields.find((f) => f.field === 'lines[1].taxablePaise')?.difference).toEqual({
      value: '250.00',
      unit: 'INR',
    });
  });

  it('FAILED: a quantity that differs carries its difference in the unit', async () => {
    const v = await verified({
      reference: reference({ qty: '90', amount: '6250.00' }),
      idempotencyKey: 'failed-qty',
    });
    expect(v.status).toBe('FAILED');
    expect(v.failed_fields.find((f) => f.field === 'lines[1].qtyMilli')?.difference).toEqual({
      value: '10.000',
      unit: 'KGS',
    });
  });

  it('REVIEW_REQUIRED, never PASSED: a required value not read with certainty (a smudged total)', async () => {
    const ref = reference({ amount: '11250.00', qty: '180', total: 13275 });
    const r0 = ref.data[0];
    if (!r0) throw new Error('reference');
    r0.invoice_info.dc_no = 'SSS/26-27/0515';
    r0.invoice_info.invoice_date = '2026-09-26';
    const v = await verified({
      file: 'D06-unreadable-total.pdf',
      reference: ref,
      idempotencyKey: 'review-1',
    });
    expect(v.status).toBe('REVIEW_REQUIRED');
    expect(v.review_required).toBe(true);
    expect(v.unverified_fields.map((f) => f.field)).toContain('header.totalPaise');
    expect(v.failed_fields).toEqual([]);
  });

  it('a document that cannot be processed is a processing error, never a FAILED verification', async () => {
    const v = await verified({ file: 'D11-two-invoices.pdf', idempotencyKey: 'error-1' });
    expect(v).toMatchObject({
      processing_status: 'error',
      status: null,
      error: { code: 'MULTIPLE_INVOICES' },
      checks: [],
    });
  });
});

describe('POST /api/v1/verify: validation', () => {
  it('refuses malformed, multi-record and missing reference JSON, and a missing reference id', async () => {
    const bad = await submit({ reference: '{not json' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'INVALID_REFERENCE' } });
    const two = reference();
    const first = two.data[0];
    if (!first) throw new Error('reference');
    two.data.push(first);
    expect((await submit({ reference: two })).json()).toMatchObject({
      error: { code: 'INVALID_REFERENCE' },
    });
    const wrong = await submit({ reference: { data: [{ invoice_info: {} }] } });
    expect(wrong.statusCode).toBe(400);
    // Where it does not fit is said; the values sent are never echoed.
    expect(
      wrong.json<{ error: { details: { issues: unknown[] } } }>().error.details.issues.length,
    ).toBeGreaterThan(0);
    expect((await submit({ referenceId: null })).json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect((await submit({ referenceId: '../../etc/passwd x' })).statusCode).toBe(400);
    expect((await submit({ idempotencyKey: 'bad key with spaces' })).statusCode).toBe(400);
  });

  it('refuses a missing, empty, disguised, damaged or oversized invoice file', async () => {
    const missing = await submit({ file: null, reference: withImages([]) });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { details: { field: 'invoice' } } });
    expect((await submit({ file: new Uint8Array() })).statusCode).toBe(415);
    const html = await submit({
      file: new TextEncoder().encode('<html><script>x</script></html>'),
    });
    expect(html.statusCode).toBe(415);
    expect(html.json()).toMatchObject({ error: { code: 'UNSUPPORTED_FILE' } });
    expect(
      (await submit({ file: new TextEncoder().encode('%PDF-1.4 truncated') })).statusCode,
    ).toBe(415);
    const big = new Uint8Array(600 * 1024);
    big.set(new TextEncoder().encode('%PDF-1.4'));
    expect((await submit({ file: big })).statusCode).toBe(413);
  });
});

/** The reference with the given files in its `images`, as the client's own export carries them. */
function withImages(files: Uint8Array[], over: Parameters<typeof reference>[0] = {}) {
  const ref = reference(over);
  const r0 = ref.data[0];
  if (!r0) throw new Error('reference');
  r0.images = files.map((f, i) => ({
    file_name: `invoice-${i + 1}.pdf`,
    mime_type: 'application/pdf',
    base64: Buffer.from(f).toString('base64'),
  }));
  return ref;
}
const json = (body: unknown, idempotencyKey?: string, key = keyA) =>
  app.anonymous({
    method: 'POST',
    url: '/api/v1/verify',
    payload: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
  });

describe('the invoice sent as base64 inside the reference', () => {
  it('a JSON request carrying the client export with the invoice in images is verified', async () => {
    const ref = withImages([doc('D01-clean-text.pdf')]);
    const res = await json({ reference_id: 'PO-7701/INV-501', ...ref }, 'json-1');
    expect(res.statusCode, res.body).toBe(202);
    const accepted = res.json<VerificationView>();
    await app.runner.drain();
    const v = (await get(accepted.verification_id)).json<VerificationView>();
    expect(v).toMatchObject({ processing_status: 'completed', status: 'PASSED' });
    // The file inside the reference is read, then dropped: neither it nor its base64 is kept.
    const [row] = await app.veyra.db
      .select()
      .from(t.verifications)
      .where(eq(t.verifications.id, v.verification_id));
    expect(row?.storageKey).toBeNull();
    expect(row?.referenceJson ?? '').not.toContain('JVBERi0');
  });

  it('a single record sent without the `data` wrapper is the same verification', async () => {
    const [record] = withImages([doc('D01-clean-text.pdf')]).data;
    const res = await json({ reference_id: 'PO-7701/INV-501-U', ...record }, 'json-unwrapped');
    expect(res.statusCode, res.body).toBe(202);
    await app.runner.drain();
    const v = (await get(res.json<VerificationView>().verification_id)).json<VerificationView>();
    expect(v).toMatchObject({ processing_status: 'completed', status: 'PASSED' });
    expect(v.summary).toMatch(/^Every value checked matches the reference/);
  });

  it('a data URL and line breaks in the base64 are accepted; the same request by multipart is the same verification', async () => {
    const file = doc('D01-clean-text.pdf');
    const ref = withImages([file]);
    const r0 = ref.data[0];
    if (!r0?.images?.[0]) throw new Error('reference');
    const b64 = r0.images[0].base64;
    r0.images[0].base64 = `data:application/pdf;base64,${b64.replace(/(.{76})/g, '$1\n')}`;
    const first = await json({ reference_id: 'PO-7701/INV-501', ...ref }, 'json-2');
    expect(first.statusCode, first.body).toBe(202);
    // Multipart with the export (invoice in images) and no file part: the same request.
    const again = await submit({ file: null, reference: ref, idempotencyKey: 'json-2' });
    expect(again.statusCode).toBe(200);
    expect(again.json<VerificationView>().verification_id).toBe(
      first.json<VerificationView>().verification_id,
    );
  });

  it('refuses no file, several files, bad base64, a disguised file and an oversized one', async () => {
    const id = { reference_id: 'PO-7701/INV-501' };
    const none = await json({ ...id, ...withImages([]) });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', details: { field: 'invoice' } },
    });
    const two = await json({
      ...id,
      ...withImages([doc('D01-clean-text.pdf'), doc('D01-clean-text.pdf')]),
    });
    expect(two.statusCode).toBe(400);
    expect(two.json()).toMatchObject({ error: { details: { field: 'images', count: 2 } } });
    const bad = withImages([doc('D01-clean-text.pdf')]);
    const b0 = bad.data[0]?.images?.[0];
    if (!b0) throw new Error('reference');
    b0.base64 = 'not base64 at all!';
    const badRes = await json({ ...id, ...bad });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json()).toMatchObject({ error: { details: { field: 'images[0].base64' } } });
    const html = await json({
      ...id,
      ...withImages([new TextEncoder().encode('<html><script>x</script></html>')]),
    });
    expect(html.statusCode).toBe(415);
    const big = new Uint8Array(600 * 1024);
    big.set(new TextEncoder().encode('%PDF-1.4'));
    expect((await json({ ...id, ...withImages([big]) })).statusCode).toBe(413);
    // No reference id, or not an object at all.
    expect((await json(withImages([doc('D01-clean-text.pdf')]))).statusCode).toBe(400);
    expect((await json([1, 2, 3])).statusCode).toBe(400);
  });

  it('the base64 path needs an API key like any other request', async () => {
    const res = await app.anonymous({
      method: 'POST',
      url: '/api/v1/verify',
      payload: JSON.stringify({ reference_id: 'X', ...withImages([doc('D01-clean-text.pdf')]) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('authentication and isolation', () => {
  it('requires a valid, active API key; a browser session is not enough', async () => {
    const none = await submit({ key: null });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/Bearer/);
    expect(
      (await submit({ key: 'vfy_aaaaaaaa_notarealkeynotarealkeynotarealkeynotareal' })).statusCode,
    ).toBe(401);
    expect((await submit({ key: revokedKey })).statusCode).toBe(401);
    // A signed-in user's cookie (the product's session) does not authenticate the API.
    const viaSession = await app.server.inject({
      method: 'GET',
      url: '/api/v1/verification/01K0000000000000000000ABCD',
    });
    expect(viaSession.statusCode).toBe(401);
  });

  it("a client cannot read or delete another client's verification (answered like a missing one)", async () => {
    const res = await submit({ idempotencyKey: 'isolation-1' });
    const id = res.json<VerificationView>().verification_id;
    const other = await get(id, keyB);
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const missing = await get('01K0000000000000000000ABCD', keyB);
    expect(missing.json()).toEqual({
      ...other.json(),
      error: {
        ...other.json<{ error: object }>().error,
        requestId: missing.json<{ error: { requestId: string } }>().error.requestId,
      },
    });
    const del = await app.anonymous({
      method: 'DELETE',
      url: `/api/v1/verification/${id}`,
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(del.statusCode).toBe(404);
    expect((await get(id)).statusCode).toBe(200);
    await app.runner.drain();
  });
});

describe('idempotency and deletion', () => {
  it('a retried request returns the same verification; a reused key with other content is refused', async () => {
    const first = await submit({ idempotencyKey: 'retry-1' });
    expect(first.statusCode).toBe(202);
    const again = await submit({ idempotencyKey: 'retry-1' });
    expect(again.statusCode).toBe(200);
    expect(again.json<VerificationView>().verification_id).toBe(
      first.json<VerificationView>().verification_id,
    );
    const conflict = await submit({
      idempotencyKey: 'retry-1',
      reference: reference({ rate: '61.00' }),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    // Without a key, the identical request is recognised too.
    const a = await submit({ referenceId: 'NO-KEY-1' });
    const b = await submit({ referenceId: 'NO-KEY-1' });
    expect(b.statusCode).toBe(200);
    expect(b.json<VerificationView>().verification_id).toBe(
      a.json<VerificationView>().verification_id,
    );
    // The same key from another client is that client's own.
    expect((await submit({ idempotencyKey: 'retry-1', key: keyB })).statusCode).toBe(202);
    await app.runner.drain();
  });

  it('DELETE removes the reference and the result, keeps an audited record of the request', async () => {
    const v = await verified({ idempotencyKey: 'delete-1' });
    const del = await app.anonymous({
      method: 'DELETE',
      url: `/api/v1/verification/${v.verification_id}`,
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(del.statusCode).toBe(204);
    const after = (await get(v.verification_id)).json<VerificationView>();
    expect(after).toMatchObject({ processing_status: 'deleted', status: null, checks: [] });
    const [row] = await app.veyra.db
      .select()
      .from(t.verifications)
      .where(eq(t.verifications.id, v.verification_id));
    expect(row).toMatchObject({ referenceJson: null, resultJson: null, storageKey: null });
    const audits = await app.veyra.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.event, 'verify.deleted'));
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.map((a) => a.detailJson).join('')).not.toMatch(/Shakti|SSS\/26/);
  });
});

describe('isolation from the product', () => {
  it('a verification creates no invoice, question or ERP record in the product', async () => {
    expect(await app.veyra.db.select().from(t.invoices)).toEqual([]);
    expect(await app.veyra.db.select().from(t.documents)).toEqual([]);
    expect(await app.veyra.erp.listPurchaseInvoices()).toEqual([]);
  });

  it('the API does not exist unless switched on', async () => {
    const d = mkdtempSync(join(tmpdir(), 'veyra-verify-off-'));
    const off = await createTestApp({
      dataDir: d,
      demo: false,
      allowFixtureExtractor: false,
      nodeEnv: 'test',
    });
    try {
      const res = await off.anonymous({ method: 'POST', url: '/api/v1/verify' });
      expect(res.statusCode).toBe(404);
    } finally {
      await off.close();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('a deployed instance accepts API keys over HTTPS only', async () => {
    const d = mkdtempSync(join(tmpdir(), 'veyra-verify-https-'));
    const staging = await createTestApp({
      dataDir: d,
      demo: false,
      allowFixtureExtractor: false,
      nodeEnv: 'test',
      environment: 'staging',
      verifyApi: true,
    });
    try {
      const key = (
        await new ApiClients(staging.veyra.db, () => staging.veyra.now()).create('Made-up')
      ).key;
      const res = await staging.anonymous({
        method: 'GET',
        url: '/api/v1/verification/01K0000000000000000000ABCD',
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: 'HTTPS_REQUIRED' } });
    } finally {
      await staging.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
