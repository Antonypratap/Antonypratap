import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiInvoiceDetail } from '@veyra/shared';
import type { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';

/**
 * A footer-tax (Tally-style) invoice end to end, with the real local reader: the text PDF is read,
 * the values are stored, matched to the ERP's goods-receipt record by invoice number and supplier,
 * and compared. The invoice (fixtures/documents/D15-tally-style.pdf) and the ERP record are
 * synthetic: a made-up supplier, with the amounts of a reported invoice.
 */
const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-tally-'));
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    demoBusiness: 'brewery',
    allowFixtureExtractor: false,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
  });
  app.runner.stop();
}, 60_000);
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await app.server.inject({ method: 'POST', url: '/api/v1/dev/reset', payload: { erp: 'empty' } });
  app.runner.stop();
});

const item = (name: string, rate: string, hsn: string) => ({
  item_name: name,
  hsn_sac_code: hsn,
  uom: 'NOS',
  quantity: '1',
  basic_rate: rate,
  basic_amount: rate,
  other_charges: [
    { code: 'GTC0000001', value: (Number(rate) * 0.09).toFixed(2) },
    { code: 'GTC0000002', value: (Number(rate) * 0.09).toFixed(2) },
  ],
});
/** The ERP's goods receipt for the invoice: its own internal order id, lines in its own order. */
const erpExport = (mirrorRate = '3450', mirrorName = 'MIRROR') => ({
  data: [
    {
      invoice_info: {
        grn_id: '7001',
        grn_no: '9001',
        po_id: '55012',
        dc_no: '13839',
        grn_date: '10/12/2025',
        invoice_date: '2025-12-09',
        invoice_amount: '5640',
        vendor_name: 'Sample Electrical and Hardware',
      },
      items: [
        item('GATTA', '40', '3926'),
        item(mirrorName, mirrorRate, '7009'),
        item('WOOD SCREW 2"', '40', '7318'),
        item('COOLIE', '1250', '9987'),
      ],
    },
  ],
});

async function upload(name: string): Promise<string> {
  const boundary = '----veyra-tally-test';
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/v1/documents',
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      readFileSync(new URL(name, DOCS)),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  await app.runner.drain();
  return res.json<{ invoiceId: string }>().invoiceId;
}
const importErp = async (body: unknown) => {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/v1/erp/receipt-records',
    payload: { filename: 'grn-9001.json', content: JSON.stringify(body) },
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  await app.runner.drain();
};
const detail = async (id: string) =>
  (
    await app.server.inject({ method: 'GET', url: `/api/v1/invoices/${id}` })
  ).json<ApiInvoiceDetail>();
const row = (inv: ApiInvoiceDetail, section: RegExp, label: string) =>
  inv.comparison?.rows.find((r) => section.test(r.section) && r.label === label);

describe('a footer-tax invoice, read locally and compared with the ERP receipt', () => {
  it('every value is stored as printed, and every item matches the ERP', async () => {
    await importErp(erpExport());
    const inv = await detail(await upload('D15-tally-style.pdf'));
    // Stored values, as read from the invoice.
    expect(inv.poNumber).toBe('684');
    expect(inv.taxablePaise).toBe(478_000);
    expect(inv.cgstPaise).toBe(43_020);
    expect(inv.sgstPaise).toBe(43_020);
    expect(inv.roundOffPaise).toBe(-40);
    expect(inv.readTotalPaise).toBe(564_000);
    expect(inv.unclearPaths).toEqual([]);
    // Compared value by value.
    expect(inv.comparison?.source).toBe('erp_receipt');
    for (const name of ['MIRROR', 'WOOD SCREW', 'GATTA', 'Coolie'])
      for (const label of ['Item', 'Quantity', 'Rate', 'Amount'])
        expect({ name, label, result: row(inv, new RegExp(name, 'i'), label)?.result }).toEqual({
          name,
          label,
          result: 'match',
        });
    expect(row(inv, /Totals/, 'Goods value')).toMatchObject({
      invoice: '₹4,780.00',
      erp: '₹4,780.00',
      result: 'match',
    });
    expect(row(inv, /Totals/, 'Invoice total')?.result).toBe('match');
    expect(row(inv, /arithmetic/, 'Lines + tax + round-off = total')?.result).toBe('match');
    // The printed order number is shown beside the ERP's internal id, never compared.
    expect(row(inv, /Purchase order/, 'Order')).toMatchObject({
      invoice: '684',
      erp: 'ERP internal reference 55012',
      result: 'not_compared',
    });
    expect(inv.comparison?.rows.filter((r) => r.result === 'mismatch')).toEqual([]);
    // The rate printed in the footer ("CGST @ 9%") proves the tax; nothing is left to ask.
    expect(row(inv, /arithmetic/, 'GST calculated from the rates')?.result).toBe('match');
    expect(inv.lines.map((l) => l.gstRateBp)).toEqual([1800, 1800, 1800, 1800]);
    expect(inv.questions).toEqual([]);
    expect(inv.comparison?.verdict).toBe('cleared');
    // The invoice's own final state: verified, waiting only for payment.
    expect(inv.state).toBe('VERIFIED_PENDING_PAYMENT');
  }, 60_000);

  it('a rate that differs from the ERP is reported with both values; the invoice’s stays', async () => {
    await importErp(erpExport('3400'));
    const inv = await detail(await upload('D15-tally-style.pdf'));
    expect(inv.comparison?.verdict).toBe('mismatch');
    expect(inv.state).toBe('NEEDS_INPUT');
    expect(row(inv, /MIRROR/, 'Rate')).toMatchObject({
      invoice: '₹3,450.00',
      erp: '₹3,400.00',
      result: 'mismatch',
    });
    expect(row(inv, /MIRROR/, 'Item')?.result).toBe('match');
    expect(inv.lines[0]?.taxablePaise).toBe(345_000);
  }, 60_000);

  it('the ERP names the mirror differently: one item to confirm, never "missing" and "extra"', async () => {
    await importErp(erpExport('3450', 'MIR-1824 GLASS'));
    const id = await upload('D15-tally-style.pdf');
    const inv = await detail(id);
    expect(inv.state).toBe('NEEDS_INPUT');
    expect(inv.comparison).toMatchObject({
      verdict: 'incomplete',
      mismatched: 0,
      unmatched: 0,
      needsConfirmation: 1,
    });
    expect(inv.comparison?.headline).toBe('Not cleared yet: 1 value to confirm');
    expect(inv.comparison?.rows.filter((r) => r.label === 'Item' && r.result !== 'match')).toEqual([
      expect.objectContaining({
        invoice: 'MIRROR',
        erp: 'MIR-1824 GLASS',
        result: 'needs_confirmation',
      }),
    ]);
    // Read values are never questioned for it, and the conclusion is to confirm, not a difference.
    expect(inv.questions).toEqual([]);
    expect(inv.finding).toMatchObject({
      state: 'confirm',
      type: 'item',
      label: 'Confirm same item',
      more: 0,
    });

    // Checked again (the same export imported again): the same result, nothing added twice.
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/v1/erp/receipt-records',
      payload: {
        filename: 'grn-9001-again.json',
        content: JSON.stringify(erpExport('3450', 'MIR-1824 GLASS')),
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    await app.runner.drain();
    const again = await detail(id);
    expect(again.comparison).toEqual(inv.comparison);
    expect(again.questions).toEqual([]);
    expect(again.finding).toEqual(inv.finding);
    const audit = (
      await app.server.inject({ method: 'GET', url: `/api/v1/audit?invoiceId=${id}` })
    ).json<{ entries?: unknown[] } | unknown[]>();
    expect(JSON.stringify(audit)).not.toContain('notChecked');
  }, 60_000);

  it('the scanned copy: a value OCR cannot read is to confirm, never a difference from the ERP', async () => {
    await importErp(erpExport());
    const inv = await detail(await upload('D16-tally-style-scan.pdf'));
    const c = inv.comparison;
    expect(c?.source).toBe('erp_receipt');
    expect(c?.mismatched).toBe(0);
    expect(c?.unmatched).toBe(0);
    expect(['cleared', 'incomplete']).toContain(c?.verdict);
    // A round-off OCR could not read is asked, and the totals wait for it (never taken as zero).
    if (c?.rows.find((r) => r.label === 'Invoice total')?.result === 'needs_confirmation')
      expect(inv.questions.map((q) => q.headline)).toContain('What is the round-off?');
    // Every line amount and rate read from the scan is the printed one, or asked.
    for (const [i, amount] of [345_000, 4_000, 4_000, 125_000].entries())
      expect([amount, null]).toContain(inv.lines[i]?.taxablePaise ?? null);
    // MIRROR is found on both sides, once.
    expect(c?.rows.filter((r) => r.label === 'Item' && /MIRROR/.test(r.section))).toHaveLength(1);
    // Every value to confirm is asked (or is the item to confirm): nothing is silently open.
    const counted =
      (c?.matched ?? 0) +
      (c?.mismatched ?? 0) +
      (c?.unmatched ?? 0) +
      (c?.needsConfirmation ?? 0) +
      (c?.notCompared ?? 0);
    expect(counted).toBe(c?.rows.length);
  }, 120_000);
});
