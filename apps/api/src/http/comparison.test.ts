import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiInvoiceDetail } from '@veyra/shared';
import type { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';

/** The invoice compared with the ERP, value by value, on the brewery demo's made-up invoices. */
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-compare-'));
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
beforeEach(async () => {
  await app.server.inject({ method: 'POST', url: '/api/v1/dev/reset', payload: { erp: 'demo' } });
  app.runner.stop();
});
async function comparisonOf(scenario: string) {
  const res = await app.server.inject({ method: 'POST', url: `/api/v1/dev/scenarios/${scenario}` });
  await app.runner.drain();
  const { invoiceId } = res.json<{ invoiceId: string }>();
  const inv = (
    await app.server.inject({ method: 'GET', url: `/api/v1/invoices/${invoiceId}` })
  ).json<ApiInvoiceDetail>();
  return inv.comparison;
}
const row = (c: ApiInvoiceDetail['comparison'], section: string, label: string) =>
  c?.rows.find((r) => r.section.startsWith(section) && r.label === label);

describe('invoice compared with the ERP', () => {
  it('a clean invoice is cleared: every value shown with its ERP value and a tick', async () => {
    const c = await comparisonOf('clean');
    expect(c).toMatchObject({ verdict: 'cleared', mismatched: 0 });
    expect(c?.headline).toBe('Cleared: every value matches your ERP');
    expect(c?.summary).toMatch(/order PO-2026-1103, receipt GRN-2026-1203\); total ₹68,440\.00/);
    expect(row(c, 'Line 1', 'Rate')).toMatchObject({
      invoice: '₹58.00',
      erp: '₹58.00',
      result: 'match',
    });
    expect(row(c, 'Supplier', 'GSTIN')).toMatchObject({
      invoice: '29AABCM2468K1Z4',
      erp: '29AABCM2468K1Z4',
      result: 'match',
    });
    expect(row(c, 'Totals', 'Invoice total')).toMatchObject({ result: 'match' });
    expect(
      c?.rows.filter((r) => r.result === 'needs_confirmation' || r.result === 'not_compared'),
    ).toEqual([]);
  });

  it('a rate above the order is a mismatch, with both values and a summary for rejecting', async () => {
    const c = await comparisonOf('rate-mismatch');
    expect(c?.verdict).toBe('mismatch');
    expect(row(c, 'Line 1', 'Rate')).toMatchObject({
      invoice: '₹1,520.00',
      erp: '₹1,450.00',
      result: 'mismatch',
    });
    expect(c?.summary).toContain('Rate: invoice ₹1,520.00, ERP ₹1,450.00');
    expect(c?.summary.length).toBeLessThanOrEqual(300);
  });

  it('a quantity over the order is a mismatch, showing ordered and received', async () => {
    const c = await comparisonOf('quantity-mismatch');
    expect(row(c, 'Line 1', 'Quantity')).toMatchObject({
      invoice: '24000 NOS',
      erp: 'Ordered 20000 NOS · received 20000 NOS',
      result: 'mismatch',
    });
  });

  it('missing goods receipt: not cleared, never a tick for what was not checked', async () => {
    const c = await comparisonOf('missing-receipt');
    expect(c?.verdict).not.toBe('cleared');
    expect(row(c, 'Goods receipt', 'Goods received')?.result).not.toBe('match');
  });

  it('an invoice not read well enough is "not compared yet", never a mismatch to reject', async () => {
    const c = await comparisonOf('unclear-scan');
    expect(c?.verdict).not.toBe('cleared');
    expect(row(c, 'Invoice', 'All required values read')?.result).not.toBe('mismatch');
    if (c?.verdict === 'incomplete')
      expect(c.headline).toBe('Not compared yet: the invoice could not be read well enough');
    expect(c?.rows.find((r) => r.label === 'Taxable value (sum of lines)')?.erp).not.toBe('₹0.00');
  }, 60_000);
});
