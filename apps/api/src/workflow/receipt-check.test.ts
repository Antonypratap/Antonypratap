import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiInvoiceDetail } from '@veyra/shared';
import type { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';
import { testSession } from '../test/auth';

/**
 * The receipt check end to end: the ERP's own goods-receipt JSON export is imported, an invoice
 * is read (a fake AI reading), matched to its record by invoice number and supplier, and compared
 * value by value. Every party, number and amount here is made up; the JSON has the same shape as
 * the ERP's export.
 */
const DOCS = new URL('../../../../fixtures/documents/brewery/', import.meta.url);
const pdf64 = (name: string) => readFileSync(new URL(name, DOCS)).toString('base64');

/** An ERP goods-receipt export, as the ERP sends it. */
function erpExport(opts: { rate?: string; pdf?: string } = {}) {
  const rate = opts.rate ?? '18.50';
  return {
    data: [
      {
        success: true,
        invoice_info: {
          grn_id: '9101',
          grn_no: '501',
          po_id: '7701',
          dc_no: 'KL/26-27/101',
          grn_date: '28/09/2026',
          invoice_date: '2026-09-30',
          invoice_amount: 0,
          branch_id: 'BRN0000001',
          vendor_name: 'Kaveri Labels Pvt. Ltd.',
          vendor_code: 'SCM0000001',
        },
        items: [
          {
            item_name: 'Neck Label Pilsner-60x40mm',
            hsn_sac_code: null,
            uom: 'NOS',
            quantity: '2000',
            basic_rate: rate,
            basic_amount: Math.round(2000 * Number(rate)),
            discount: 0,
            cgst: 0,
            sgst: 0,
            igst: 0,
            freight: 0,
            other_charges: [
              { code: 'GTC0000001', value: (2000 * Number(rate) * 0.09).toFixed(2) },
              { code: 'GTC0000002', value: (2000 * Number(rate) * 0.09).toFixed(2) },
            ],
          },
        ],
        images: [
          {
            file_name: 'KL-101.pdf',
            mime_type: 'application/pdf',
            base64: pdf64(opts.pdf ?? 'B01-clean.pdf'),
          },
        ],
      },
    ],
    info: null,
    error: false,
  };
}

const p = (printed: string) => ({ printed, page: 1 });
/** What the (fake) AI reads on the invoice. */
let reading: Record<string, unknown>;
const invoiceReading = (
  rate = '18.50',
  amount = '37,000.00',
  tax = '3,330.00',
  total = '43,660.00',
) => ({
  invoiceCount: 1,
  pageCount: 1,
  header: {
    vendorName: p('Kaveri Labels Pvt Ltd'),
    vendorGstin: p('29AABCM2468K1Z4'),
    buyerGstin: p('29AAICH4826L1Z2'),
    invoiceNumber: p('KL/26-27/101'),
    invoiceDate: p('27/09/2026'),
    poNumber: p('PO-88'),
    taxable: p(amount),
    cgst: p(tax),
    sgst: p(tax),
    total: p(total),
  },
  lines: [
    {
      description: p('NECK LABEL PILSNER - 60X40MM'),
      hsn: p('4821'),
      quantity: p('2,000'),
      uom: p('Nos'),
      rate: p(rate),
      taxable: p(amount),
      gstRate: p('18%'),
    },
  ],
});
const fetch = (async () =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reading) }] } }] }),
  )) as unknown as typeof globalThis.fetch;

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-receipt-'));
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    demoBusiness: 'brewery',
    allowFixtureExtractor: false,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
    ai: { apiKey: 'test-key-0123456789abcdef', model: 'gemini-test', fetch },
  });
  app.runner.stop();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await app.server.inject({ method: 'POST', url: '/api/v1/dev/reset', payload: { erp: 'empty' } });
  app.runner.stop();
  reading = invoiceReading();
});

const importExport = (body: unknown, filename = 'grn-501.json') =>
  app.server.inject({
    method: 'POST',
    url: '/api/v1/erp/receipt-records',
    payload: { filename, content: JSON.stringify(body) },
  });
async function checkAttached(): Promise<ApiInvoiceDetail> {
  const records = (
    await app.server.inject({ method: 'GET', url: '/api/v1/erp/receipt-records' })
  ).json<{ id: string }[]>();
  const res = await app.server.inject({
    method: 'POST',
    url: `/api/v1/erp/receipt-records/${records[0]?.id}/check`,
  });
  expect(res.statusCode, res.body).toBe(201);
  await app.runner.drain();
  return detail(res.json<{ invoiceId: string }>().invoiceId);
}
const detail = async (id: string) =>
  (
    await app.server.inject({ method: 'GET', url: `/api/v1/invoices/${id}` })
  ).json<ApiInvoiceDetail>();
/** Uploads an invoice file (synthetic; the fake AI reading above is what it "says"). */
async function upload(name: string): Promise<string> {
  const boundary = '----veyra-receipt-test';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    readFileSync(new URL(name, DOCS)),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/v1/documents',
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ invoiceId: string }>().invoiceId;
}
const row = (inv: ApiInvoiceDetail, label: string) =>
  inv.comparison?.rows.find((r) => r.label === label);

describe('the receipt check: invoices against the ERP’s own goods-receipt records', () => {
  it('imports the ERP export, and an invoice matching it in every value is cleared', async () => {
    const res = await importExport(erpExport());
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ imported: 1 });
    const list = (
      await app.server.inject({ method: 'GET', url: '/api/v1/erp/receipt-records' })
    ).json();
    expect(list).toMatchObject([
      {
        grnNo: '501',
        vendorName: 'Kaveri Labels Pvt. Ltd.',
        invoiceNo: 'KL/26-27/101',
        attachment: 'KL-101.pdf',
      },
    ]);

    const inv = await checkAttached();
    // Cleared without asking to create a supplier, item or order: the ERP record is the reference.
    expect(inv.state).toBe('VERIFIED_PENDING_PAYMENT');
    expect(inv.questions).toEqual([]);
    // Honest: what the ERP record does not hold (here its GSTIN) is not called a match.
    expect(inv.comparison).toMatchObject({ verdict: 'cleared', mismatched: 0 });
    expect(inv.comparison?.headline).toMatch(/^Cleared: \d+ values match ERP receipt GRN 501$/);
    expect(inv.comparison?.summary).toMatch(/not held by the ERP were not compared \(GSTIN/);
    // The invoice's own checks ran too: the GSTIN itself, the line, the tax and the total.
    expect(row(inv, 'GSTIN valid')).toMatchObject({ result: 'match' });
    expect(row(inv, 'GST calculated from the rates')).toMatchObject({ result: 'match' });
    expect(row(inv, 'Lines + tax + round-off = total')).toMatchObject({ result: 'match' });
    expect(row(inv, 'Not already in Veyrafy')).toMatchObject({ result: 'match' });
    expect(row(inv, 'Matched ERP record')).toMatchObject({ erp: 'GRN 501 of 28 Sep 2026' });
    expect(row(inv, 'Item')).toMatchObject({ result: 'match' });
    expect(row(inv, 'CGST')).toMatchObject({
      invoice: '₹3,330.00',
      erp: '₹3,330.00',
      result: 'match',
    });
    expect(row(inv, 'Invoice total')).toMatchObject({ result: 'match' });
    // What the ERP does not hold is said, never ticked.
    expect(row(inv, 'GSTIN')).toMatchObject({
      result: 'not_compared',
      note: 'The ERP record carries no GSTIN.',
    });
    const audit = JSON.stringify(
      (await app.server.inject({ method: 'GET', url: `/api/v1/audit?invoiceId=${inv.id}` })).json(),
    );
    expect(audit).toContain('Cleared against ERP receipt GRN 501');
  });

  it('a rate that differs from the ERP waits for you, shows both values, and can be rejected', async () => {
    await importExport(erpExport({ rate: '18.00', pdf: 'B02-missing-receipt.pdf' }));
    const inv = await checkAttached();
    expect(inv.state).toBe('NEEDS_INPUT');
    expect(inv.comparison?.verdict).toBe('mismatch');
    expect(row(inv, 'Rate')).toMatchObject({
      invoice: '₹18.50',
      erp: '₹18.00',
      result: 'mismatch',
    });
    expect(inv.comparison?.summary).toContain('Rate: invoice ₹18.50, ERP ₹18.00');
    const res = await app.server.inject({
      method: 'POST',
      url: `/api/v1/invoices/${inv.id}/reject`,
      payload: { reason: inv.comparison?.summary.slice(0, 300) },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await detail(inv.id)).state).toBe('REJECTED');
  });

  it('after the ERP record is corrected and imported again, a re-check clears the invoice', async () => {
    await importExport(erpExport({ rate: '18.00', pdf: 'B03-ambiguous-supplier.pdf' }));
    const inv = await checkAttached();
    expect(inv.state).toBe('NEEDS_INPUT');
    // Importing the corrected record checks the waiting invoice again by itself.
    const fixed = await importExport(
      { ...erpExport(), data: erpExport().data.map((d) => ({ ...d, images: [] })) },
      'grn-501-fixed.json',
    );
    expect(fixed.json()).toMatchObject({ imported: 1, rechecked: 1 });
    await app.runner.drain();
    const after = await detail(inv.id);
    expect(after.state).toBe('VERIFIED_PENDING_PAYMENT');
    expect(after.comparison?.verdict).toBe('cleared');
  });

  it('a value not read with certainty is asked; once answered, the invoice is compared and cleared', async () => {
    // A two-digit year is not a valid date (RULES §1.4): the date is asked, never guessed.
    reading = {
      ...invoiceReading(),
      header: { ...invoiceReading().header, invoiceDate: p('27-Sep-26') },
    };
    await importExport(erpExport({ pdf: 'B04-quantity-mismatch.pdf' }));
    const inv = await checkAttached();
    expect(inv.state).toBe('NEEDS_INPUT');
    expect(inv.comparison?.verdict).toBe('incomplete');
    expect(row(inv, 'Invoice date')).toMatchObject({
      invoice: null,
      result: 'needs_confirmation',
    });
    const open = inv.questions.filter((q) => q.status === 'open');
    expect(open.map((q) => q.code)).toEqual(['MD_FIELD']);
    expect(open[0]?.headline).toBe('What is the invoice date?');
    // The questions list says what is needed, not "couldn't finish".
    const list = (await app.server.inject({ method: 'GET', url: '/api/v1/questions' })).json<
      { id: string; invoiceId: string }[]
    >();
    const q = list.find((x) => x.invoiceId === inv.id);
    expect(q?.id).toBe(open[0]?.id);
    const res = await app.server.inject({
      method: 'POST',
      url: `/api/v1/questions/${q?.id}/answer`,
      payload: { optionId: 'set:header.invoiceDate', input: '27/09/2026' },
    });
    expect(res.statusCode, res.body).toBe(200);
    await app.runner.drain();
    const after = await detail(inv.id);
    expect(after.comparison?.verdict).toBe('cleared');
    expect(after.state).toBe('VERIFIED_PENDING_PAYMENT');
  });

  it('the original document can be deleted by an administrator; the invoice record stays', async () => {
    await importExport(erpExport({ rate: '18.00', pdf: 'B05-rate-mismatch.pdf' }));
    const inv = await checkAttached();
    const finance = await testSession(app, { role: 'FINANCE' });
    const del = (headers?: Record<string, string>) =>
      app.server.inject({
        method: 'POST',
        url: `/api/v1/documents/${inv.documentId}/delete`,
        payload: {},
        ...(headers ? { headers } : {}),
      });
    expect((await del(finance.headers)).statusCode).toBe(403);
    expect(
      (
        await app.server.inject({
          method: 'PUT',
          url: '/api/v1/settings/retention',
          payload: { mode: 'DELETE_AFTER_SUCCESS' },
          headers: finance.headers,
        })
      ).statusCode,
    ).toBe(403);
    const res = await del();
    expect(res.statusCode, res.body).toBe(200);
    expect((await del()).json()).toMatchObject({ status: 'DELETED', deleted: false }); // idempotent
    // The invoice, its comparison and its history are still there; the original is not.
    const after = await detail(inv.id);
    expect([after.state, after.comparison?.verdict]).toEqual(['NEEDS_INPUT', 'mismatch']);
    const doc = (
      await app.server.inject({ method: 'GET', url: `/api/v1/documents/${inv.documentId}` })
    ).json<{ status: string; deletedAt: string | null }>();
    expect(doc).toMatchObject({ status: 'DELETED', deletedAt: expect.any(String) });
    for (const url of [
      `/api/v1/documents/${inv.documentId}/file`,
      `/api/v1/documents/${inv.documentId}/pages/1`,
    ])
      expect((await app.server.inject({ method: 'GET', url })).statusCode).toBe(404);
    const audit = JSON.stringify(
      (await app.server.inject({ method: 'GET', url: `/api/v1/audit?invoiceId=${inv.id}` })).json(),
    );
    expect(audit).toContain('You deleted the original invoice document');
    // The policy: readable by anyone signed in, set by an administrator, range-checked.
    const put = (payload: Record<string, unknown>) =>
      app.server.inject({ method: 'PUT', url: '/api/v1/settings/retention', payload });
    expect((await put({ mode: 'DELETE_AFTER_DAYS', days: 0 })).statusCode).toBe(422);
    expect((await put({ mode: 'DELETE_AFTER_DAYS', days: 45 })).json()).toEqual({
      mode: 'DELETE_AFTER_DAYS',
      days: 45,
    });
    expect(
      (await app.server.inject({ method: 'GET', url: '/api/v1/settings/retention' })).json(),
    ).toEqual({ mode: 'DELETE_AFTER_DAYS', days: 45 });
    await put({ mode: 'KEEP' });
  });

  it('the same ERP file imported twice is stored once; a corrected record is stored again', async () => {
    const first = (await importExport(erpExport())).json<{
      imported: number;
      records: { id: string; grnNo: string; alreadyImported: boolean }[];
    }>();
    expect(first).toMatchObject({
      imported: 1,
      records: [{ grnNo: '501', alreadyImported: false }],
    });
    const again = (await importExport(erpExport())).json<typeof first>();
    expect(again).toMatchObject({
      imported: 0,
      records: [{ id: first.records[0]?.id, alreadyImported: true }],
    });
    const corrected = (await importExport(erpExport({ rate: '18.00' }))).json<typeof first>();
    expect(corrected.imported).toBe(1);
    const list = (
      await app.server.inject({ method: 'GET', url: '/api/v1/erp/receipt-records' })
    ).json<unknown[]>();
    expect(list).toHaveLength(2);
  });

  it('the invoice uploaded first, the ERP export after: the invoice is checked against it', async () => {
    const up = await upload('B04-quantity-mismatch.pdf');
    await app.runner.drain();
    expect((await detail(up)).state).toBe('NEEDS_INPUT'); // no ERP record yet
    const res = await importExport(
      { ...erpExport(), data: erpExport().data.map((d) => ({ ...d, images: [] })) },
      'grn-501.json',
    );
    expect(res.json()).toMatchObject({ imported: 1, rechecked: 1 });
    await app.runner.drain();
    const inv = await detail(up);
    expect(inv.state).toBe('VERIFIED_PENDING_PAYMENT');
    expect(inv.comparison?.verdict).toBe('cleared');
  });

  it('importing the ERP export never adds an invoice by itself', async () => {
    await importExport(erpExport()); // it carries the invoice PDF inside
    const inbox = (await app.server.inject({ method: 'GET', url: '/api/v1/invoices' })).json<{
      invoices: unknown[];
    }>();
    expect(inbox.invoices).toEqual([]);
  });

  it('a second copy of an invoice already cleared is not cleared again: possible duplicate', async () => {
    await importExport(erpExport());
    const first = await checkAttached();
    expect(first.state).toBe('VERIFIED_PENDING_PAYMENT');
    // The same invoice uploaded again as another file (a second scan): same number, same supplier.
    const again = await upload('B05-rate-mismatch.pdf');
    await app.runner.drain();
    const inv = await detail(again);
    expect(inv.state).toBe('NEEDS_INPUT');
    expect(row(inv, 'Not already in Veyrafy')).toMatchObject({
      result: 'mismatch',
      erp: 'Also in Veyrafy: KL-101.pdf',
    });
    expect(inv.finding).toMatchObject({
      type: 'duplicate',
      label: 'Possible duplicate',
      action: 'Resolve duplicate',
      impact: '₹43,660.00 could be paid twice',
    });
  });

  it('an invalid supplier GSTIN is never cleared, even when everything matches the ERP', async () => {
    reading = {
      ...invoiceReading(),
      header: { ...invoiceReading().header, vendorGstin: p('29AABCM2468K1Z5') },
    };
    await importExport(erpExport());
    const inv = await checkAttached();
    expect(inv.state).toBe('NEEDS_INPUT');
    expect(row(inv, 'GSTIN valid')).toMatchObject({ result: 'mismatch', erp: 'Not a valid GSTIN' });
    expect(inv.finding).toMatchObject({
      label: 'Invalid supplier GSTIN',
      action: 'Check supplier',
    });
  });

  it('tax that is wrong on the invoice and in the ERP alike is caught by the invoice’s own arithmetic', async () => {
    // 18% of ₹37,000 is ₹6,660 (₹3,330 each head); both sides say ₹3,400 each.
    reading = invoiceReading('18.50', '37,000.00', '3,400.00', '43,800.00');
    const base = erpExport();
    const wrong = {
      ...base,
      data: base.data.map((d) => ({
        ...d,
        items: d.items.map((it) => ({
          ...it,
          other_charges: [
            { code: 'GTC0000001', value: '3400.00' },
            { code: 'GTC0000002', value: '3400.00' },
          ],
        })),
      })),
    };
    await importExport(wrong);
    const inv = await checkAttached();
    expect(row(inv, 'CGST')).toMatchObject({ result: 'match' }); // the ERP agrees…
    expect(row(inv, 'GST calculated from the rates')).toMatchObject({
      result: 'mismatch',
      invoice: '₹6,800.00',
      erp: '₹6,660.00 calculated',
    });
    expect(inv.state).toBe('NEEDS_INPUT'); // …but the invoice is not cleared
    expect(inv.finding).toMatchObject({ label: "Tax doesn't add up" });
  });

  it('a file that is not an ERP goods-receipt export is refused, saying why', async () => {
    const res = await importExport({ rows: [] });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(
      /isn't a goods-receipt export Veyrafy recognises/,
    );
  });

  it('emptying the ERP removes the imported records', async () => {
    await importExport(erpExport());
    await app.server.inject({
      method: 'POST',
      url: '/api/v1/dev/reset',
      payload: { erp: 'empty' },
    });
    app.runner.stop();
    expect(
      (await app.server.inject({ method: 'GET', url: '/api/v1/erp/receipt-records' })).json(),
    ).toEqual([]);
  });
});
