import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiInvoiceDetail, ApiQuestion } from '@veyra/shared';
import type { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';

/**
 * The hosted demo's brewery (docs/DEMO.md §10): its own ERP seed and its own invoices, through
 * the real extractor and the unchanged workflow. Each scenario must tell the same story as the
 * manufacturing one (scenarios.test.ts), with brewery data.
 */
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-brewery-'));
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    demoBusiness: 'brewery',
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
const reset = async (erp: 'demo' | 'empty' = 'demo') => {
  await app.server.inject({ method: 'POST', url: '/api/v1/dev/reset', payload: { erp } });
  app.runner.stop();
};
beforeEach(() => reset());

const get = async <T>(url: string): Promise<T> =>
  (await app.server.inject({ method: 'GET', url })).json<T>();
async function start(key: string): Promise<string> {
  const res = await app.server.inject({ method: 'POST', url: `/api/v1/dev/scenarios/${key}` });
  expect(res.statusCode, res.body).toBe(201);
  await app.runner.drain();
  return res.json<{ invoiceId: string }>().invoiceId;
}
const detail = (id: string) => get<ApiInvoiceDetail>(`/api/v1/invoices/${id}`);
const question = async (id: string) =>
  (await get<ApiQuestion[]>('/api/v1/questions')).find((q) => q.invoiceId === id);
async function answer(q: ApiQuestion, optionId: string, input?: unknown) {
  const res = await app.server.inject({
    method: 'POST',
    url: `/api/v1/questions/${q.id}/answer`,
    payload: { optionId, ...(input === undefined ? {} : { input }) },
  });
  expect(res.statusCode, res.body).toBe(200);
  await app.runner.drain();
}

describe('the brewery sample business', () => {
  it('seeds the brewery ERP: its company, suppliers, items, orders and receipts', async () => {
    const vendors = await get<{ code: string; name: string }[]>('/api/v1/erp/vendors');
    expect(vendors.map((v) => v.name)).toEqual([
      'Malabar Malt House Pvt Ltd',
      'Himalayan Hop Traders Pvt Ltd',
      'Deccan Glass Works',
      'Coromandel Crown Closures Pvt Ltd',
      'Kaveri Cartons',
      'Kaveri Cartons & Co',
      'Nandi Gases Pvt Ltd',
    ]);
    const items = await get<{ name: string }[]>('/api/v1/erp/items');
    expect(items.map((i) => i.name)).toContain('Cascade Hop Pellets');
    expect((await get<unknown[]>('/api/v1/erp/purchase-orders')).length).toBe(12);
    expect((await get<unknown[]>('/api/v1/erp/grns')).length).toBe(11); // PO-2026-1105 has none
  });

  it('an empty business keeps only the brewery itself', async () => {
    await reset('empty');
    expect(await get<unknown[]>('/api/v1/erp/vendors')).toEqual([]);
    await reset('demo');
    expect((await get<unknown[]>('/api/v1/erp/vendors')).length).toBe(7);
  });
});

describe('brewery demo scenarios', () => {
  it('clean invoice: malt matched to its order and receipt, recorded with no questions', async () => {
    const id = await start('clean');
    const inv = await detail(id);
    expect(inv).toMatchObject({ state: 'VERIFIED_PENDING_PAYMENT', status: 'handled' });
    expect(await question(id)).toBeUndefined();
    expect(inv.erp).toMatchObject({
      vendor: 'Malabar Malt House Pvt Ltd (V001)',
      poNumber: 'PO-2026-1103',
      receipts: [{ number: 'GRN-2026-1203', byYou: false }],
      purchaseInvoice: { status: 'verified_pending_payment', lines: 1, totalPaise: 6_844_000 },
    });
  });

  it('missing goods receipt: asks whether the hops arrived; your receipt → ready', async () => {
    const id = await start('missing-receipt');
    const q = await question(id);
    expect(q).toMatchObject({
      code: 'CA_GRN',
      headline: 'Did the goods arrive?',
      evidence: 'Found the supplier and PO-2026-1105, but no goods receipt yet',
    });
    await answer(q as ApiQuestion, 'confirm', {
      grnDate: '2026-09-26',
      lines: [{ poLineNo: 1, received: '20', accepted: '20' }],
    });
    const inv = await detail(id);
    expect(inv).toMatchObject({ state: 'VERIFIED_PENDING_PAYMENT', status: 'ready' });
    expect(inv.erp.purchaseInvoice?.totalPaise).toBe(3_045_000);
  });

  it('ambiguous supplier: both Kaveri Cartons with their GSTINs; your choice → verified', async () => {
    const id = await start('ambiguous-supplier');
    const q = await question(id);
    expect(q).toMatchObject({ code: 'AM_VENDOR', headline: 'Which supplier sent this invoice?' });
    expect(q?.options.map((o) => o.label)).toEqual(
      expect.arrayContaining([
        'Kaveri Cartons (29ABKPK1122M1ZJ)',
        'Kaveri Cartons & Co (29AAJFK3344N1ZT)',
      ]),
    );
    await answer(q as ApiQuestion, 'vendor:V005');
    expect((await detail(id)).state).toBe('VERIFIED_PENDING_PAYMENT');
  });

  it('quantity mismatch: 24,000 crown corks invoiced against 20,000 ordered; no override', async () => {
    const q = await question(await start('quantity-mismatch'));
    expect(q).toMatchObject({ code: 'VF_R23', kind: 'VALIDATION_FAILURE' });
    expect(q?.facts).toEqual([
      { label: 'Invoiced', value: '24000 NOS', tone: 'attention' },
      { label: 'Ordered', value: '20000 NOS' },
      { label: 'Already invoiced', value: '0 NOS' },
    ]);
    expect(q?.options.map((o) => o.id)).toEqual(['set:lines[1].qtyMilli', 'recheck', 'reject']);
  });

  it('rate mismatch: hops at ₹1,520.00 against the order at ₹1,450.00; no override', async () => {
    const q = await question(await start('rate-mismatch'));
    expect(q?.facts).toEqual([
      { label: 'Invoice price', value: '₹1,520.00 per KGS', tone: 'attention' },
      { label: 'PO-2026-1106 price', value: '₹1,450.00 per KGS' },
      { label: 'Difference', value: '₹70.00 per KGS' },
    ]);
  });

  it('photo needs confirmation: shows what OCR read; a misread GSTIN must be entered', async () => {
    const id = await start('unclear-scan');
    const q = await question(id);
    expect(q).toMatchObject({ code: 'MD_FIELD', paths: ['header.buyerGstin'] });
    expect(q?.facts[0]).toMatchObject({ label: 'Veyrafy read', tone: 'attention' });
    expect(q?.options.map((o) => o.id)).toEqual(['set:header.buyerGstin', 'reject']);
    await answer(q as ApiQuestion, 'set:header.buyerGstin', '29AAICH4826L1Z2');
    expect((await detail(id)).state).not.toBe('FAILED');
  }, 60_000);

  it('two invoices in one file: stopped, never merged', async () => {
    const inv = await detail(await start('two-invoices'));
    expect(inv.state).toBe('FAILED');
    expect(inv.failure?.reason).toMatch(/MMH\/26-27\/0425, MMH\/26-27\/0426/);
    expect(inv.failure?.reason).toMatch(/Upload each invoice as its own file/);
  });
});
