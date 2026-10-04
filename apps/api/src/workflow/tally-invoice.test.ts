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
const erpExport = (mirrorRate = '3450') => ({
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
        item('MIRROR', mirrorRate, '7009'),
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
      erp: 'ERP reference 55012',
      result: 'not_checked',
    });
    expect(inv.comparison?.rows.filter((r) => r.result === 'mismatch')).toEqual([]);
  }, 60_000);

  it('a rate that differs from the ERP is reported with both values; the invoice’s stays', async () => {
    await importErp(erpExport('3400'));
    const inv = await detail(await upload('D15-tally-style.pdf'));
    expect(inv.comparison?.verdict).toBe('mismatch');
    expect(row(inv, /MIRROR/, 'Rate')).toMatchObject({
      invoice: '₹3,450.00',
      erp: '₹3,400.00',
      result: 'mismatch',
    });
    expect(row(inv, /MIRROR/, 'Item')?.result).toBe('match');
    expect(inv.lines[0]?.taxablePaise).toBe(345_000);
  }, 60_000);
});
