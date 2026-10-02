import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiInvoiceDetail } from '@veyra/shared';
import type { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';

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
const row = (inv: ApiInvoiceDetail, label: string) =>
  inv.comparison?.rows.find((r) => r.label === label);

describe('the receipt check: invoices against the ERP’s own goods-receipt records', () => {
  it('imports the ERP export, and an invoice matching it in every value is cleared', async () => {
    const res = await importExport(erpExport());
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ imported: 1 });
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
    expect(inv.comparison).toMatchObject({
      verdict: 'cleared',
      mismatched: 0,
      headline: 'Cleared: every value matches ERP receipt GRN 501',
    });
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
      result: 'not_checked',
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
    await importExport(
      { ...erpExport(), data: erpExport().data.map((d) => ({ ...d, images: [] })) },
      'grn-501-fixed.json',
    );
    const res = await app.server.inject({
      method: 'POST',
      url: `/api/v1/invoices/${inv.id}/recheck`,
    });
    expect(res.statusCode, res.body).toBe(200);
    await app.runner.drain();
    const after = await detail(inv.id);
    expect(after.state).toBe('VERIFIED_PENDING_PAYMENT');
    expect(after.comparison?.verdict).toBe('cleared');
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
