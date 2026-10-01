import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiInvoiceDetail } from '@veyra/shared';
import type { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';

/**
 * The AI reader end to end: a (fake) Gemini answer for the brewery's clean invoice goes through the
 * unchanged workflow, the engine verifies it against the ERP, and the stored values say how they were
 * read. Made-up data only.
 */
const p = (printed: string) => ({ printed, page: 1 });
const READING = {
  invoiceCount: 1,
  pageCount: 1,
  header: {
    vendorName: p('Malabar Malt House Pvt Ltd'),
    vendorGstin: p('29AABCM2468K1Z4'),
    buyerGstin: p('29AAICH4826L1Z2'),
    placeOfSupply: p('Karnataka (29)'),
    invoiceNumber: p('MMH/26-27/0412'),
    invoiceDate: p('27/09/2026'),
    poNumber: p('PO-2026-1103'),
    taxable: p('58,000.00'),
    cgst: p('5,220.00'),
    sgst: p('5,220.00'),
    roundOff: p('0.00'),
    total: p('68,440.00'),
  },
  lines: [
    {
      description: p('Pilsner Malt'),
      itemCode: p('PM-25'),
      hsn: p('1107'),
      quantity: p('1,000.000'),
      uom: p('KGS'),
      rate: p('58.00'),
      taxable: p('58,000.00'),
      gstRate: p('18%'),
    },
  ],
};
const fetch = (async () =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(READING) }] } }] }),
  )) as unknown as typeof globalThis.fetch;

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-ai-reader-'));
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

describe('AI reader in the workflow', () => {
  it('a clean invoice read by the AI is verified against the ERP and recorded, with its method', async () => {
    const bytes = new Uint8Array(
      readFileSync(
        new URL('../../../../fixtures/documents/brewery/B01-clean.pdf', import.meta.url),
      ),
    );
    const { invoiceId } = await app.veyra.upload({ filename: 'B01-clean.pdf', bytes });
    await app.runner.drain();
    const inv = (
      await app.server.inject({ method: 'GET', url: `/api/v1/invoices/${invoiceId}` })
    ).json<ApiInvoiceDetail>();
    expect(inv).toMatchObject({ state: 'VERIFIED_PENDING_PAYMENT', status: 'handled' });
    expect(inv.erp).toMatchObject({
      vendor: 'Malabar Malt House Pvt Ltd (V001)',
      poNumber: 'PO-2026-1103',
      purchaseInvoice: { totalPaise: 6_844_000 },
    });
    const audit = (
      await app.server.inject({ method: 'GET', url: `/api/v1/audit?invoiceId=${invoiceId}` })
    ).json<{ detail?: string | null; title: string }[]>();
    expect(JSON.stringify(audit)).toContain('the AI reader, every value checked by Veyrafy');
  });
});
