import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderScenario, scenarioById } from '@veyra/extractor';
import type { ApiImport, ApiInvoiceDetail, ApiQuestion } from '@veyra/shared';
import type { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';

/**
 * Phase 3C proof: a business with no ERP connection provides its records in Excel, and the
 * existing invoice workflow runs against exactly those records, end to end.
 */
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;
const FIXTURES = new URL('../../../../fixtures/imports/', import.meta.url);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-e2e-'));
  app = await createTestApp({
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

function multipart(filename: string, bytes: Uint8Array) {
  const boundary = '----veyra-e2e';
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

async function importFile(name: string): Promise<ApiImport> {
  const checked = (
    await app.server.inject({
      method: 'POST',
      url: '/api/v1/imports',
      ...multipart(name, readFileSync(new URL(name, FIXTURES))),
    })
  ).json<ApiImport>();
  expect(checked.errors, name).toEqual([]);
  const done = await app.server.inject({
    method: 'POST',
    url: `/api/v1/imports/${checked.id}/confirm`,
  });
  expect(done.statusCode).toBe(200);
  return done.json<ApiImport>();
}

async function uploadInvoice(id: string): Promise<string> {
  const s = scenarioById(id);
  if (!s) throw new Error(id);
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/v1/documents',
    ...multipart(s.file, renderScenario(s)),
  });
  await app.runner.drain();
  return res.json<{ invoiceId: string }>().invoiceId;
}

describe('Excel → invoice → question → decision → ERP → VERIFIED_PENDING_PAYMENT', () => {
  it('1. starts from an empty business (company only)', async () => {
    await app.server.inject({
      method: 'POST',
      url: '/api/v1/dev/reset',
      payload: { erp: 'empty' },
    });
    app.runner.stop();
    expect(await app.veyra.erp.listVendors()).toEqual([]);
    expect(await app.veyra.erp.listPurchaseOrders()).toEqual([]);
  });

  it('2–5. imports vendors, items, purchase orders and goods receipts, in that order', async () => {
    expect((await importFile('Demo-1-Vendors.xlsx')).result?.created.vendors).toBe(7);
    expect((await importFile('Demo-2-Items.xlsx')).result?.created.items).toBe(7);
    expect((await importFile('Demo-3-PurchaseOrders.xlsx')).result?.created.purchaseOrders).toBe(
      13,
    );
    expect((await importFile('Demo-4-GoodsReceipts.xlsx')).result?.created.grns).toBe(12);
    expect((await app.veyra.erp.listVendors()).every((v) => v.origin === 'imported')).toBe(true);
  });

  it('6–14. an invoice is read, matched to the imported records, questioned, decided and recorded', async () => {
    // S08 cites PO-2026-0104, which the business imported without a goods receipt.
    const invoiceId = await uploadInvoice('S08');
    let detail = await get<ApiInvoiceDetail>(`/api/v1/invoices/${invoiceId}`);
    expect(detail.state).toBe('NEEDS_INPUT');
    expect(detail.erp.vendor).toBe('Apex Components Pvt Ltd (V002)'); // the imported vendor
    const [question] = await get<ApiQuestion[]>('/api/v1/questions');
    expect(question).toMatchObject({
      code: 'CA_GRN',
      evidence: 'Found the supplier and PO-2026-0104, but no goods receipt yet',
    });

    await app.server.inject({
      method: 'POST',
      url: `/api/v1/questions/${question?.id}/answer`,
      payload: {
        optionId: 'confirm',
        input: { grnDate: '2026-09-20', lines: [{ poLineNo: 1, received: '50', accepted: '50' }] },
      },
    });
    await app.runner.drain();

    detail = await get<ApiInvoiceDetail>(`/api/v1/invoices/${invoiceId}`);
    expect(detail).toMatchObject({ state: 'VERIFIED_PENDING_PAYMENT', status: 'ready' });
    expect(detail.checks.every((c) => c.outcome === 'pass' || c.outcome === 'not_applicable')).toBe(
      true,
    );
    const [recorded] = await app.veyra.erp.listPurchaseInvoices();
    const po = await app.veyra.erp.getPurchaseOrder(recorded?.poId as never);
    expect(po).toMatchObject({ poNumber: 'PO-2026-0104', origin: 'imported' });
    expect(recorded).toMatchObject({
      vendorInvoiceNo: 'APX-7790',
      status: 'verified_pending_payment',
    });
  });

  it('a clean invoice against imported records needs nobody', async () => {
    const invoiceId = await uploadInvoice('S01');
    expect((await get<ApiInvoiceDetail>(`/api/v1/invoices/${invoiceId}`)).status).toBe('handled');
  });

  it('imported receipts are enforced exactly: 200 invoiced against 180 received is asked, not passed', async () => {
    const invoiceId = await uploadInvoice('S10');
    expect((await get<ApiInvoiceDetail>(`/api/v1/invoices/${invoiceId}`)).question?.summary).toBe(
      'Quantity differs',
    );
  });
});
