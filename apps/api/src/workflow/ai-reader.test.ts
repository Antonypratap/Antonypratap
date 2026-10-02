import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageOnlyStripPdf } from '@veyra/extractor';
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
  otherPrinted: [{ label: 'Terms of Payment', printed: '30 days', page: 1 }],
};
/** What each (fake) Gemini call was sent: the kinds of its parts, never asserted on content. */
const sent: string[][] = [];
const fetch = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as {
    contents: { parts: ({ text: string } | { inline_data: { mime_type: string } })[] }[];
  };
  sent.push(
    (body.contents[0]?.parts ?? []).map((x) => ('text' in x ? 'text' : x.inline_data.mime_type)),
  );
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(READING) }] } }] }),
  );
}) as unknown as typeof globalThis.fetch;
/** The server log, captured. */
const logLines: Record<string, unknown>[] = [];
const log = pino(
  { level: 'info' },
  { write: (line: string) => void logLines.push(JSON.parse(line) as Record<string, unknown>) },
);
const B01 = new URL('../../../../fixtures/documents/brewery/B01-clean.pdf', import.meta.url);

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
    log,
  });
  app.runner.stop();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('AI reader in the workflow', () => {
  it('a clean invoice read by the AI is verified against the ERP and recorded, with its method', async () => {
    const bytes = new Uint8Array(readFileSync(B01));
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
    expect(JSON.stringify(audit)).toContain('the page itself, every value checked by Veyrafy');
  });

  it('a PDF with NO text layer is read visually (every page as an image), verified and shown', async () => {
    // A fresh business (the first test already recorded this invoice: it would be a duplicate).
    await app.server.inject({ method: 'POST', url: '/api/v1/dev/reset', payload: { erp: 'demo' } });
    app.runner.stop();
    const bytes = await imageOnlyStripPdf(new Uint8Array(readFileSync(B01)), 1);
    sent.length = 0;
    logLines.length = 0;
    const { invoiceId, documentId } = await app.veyra.upload({ filename: 'scan.pdf', bytes });
    await app.runner.drain();
    // The reader was given the page as an image, not a PDF it would need to find text in.
    expect(sent).toEqual([['text', 'image/jpeg', 'text']]);
    const inv = (
      await app.server.inject({ method: 'GET', url: `/api/v1/invoices/${invoiceId}` })
    ).json<ApiInvoiceDetail>();
    // Not "No text could be read": read, then verified against the ERP like any invoice.
    expect(inv).toMatchObject({ state: 'VERIFIED_PENDING_PAYMENT', number: 'MMH/26-27/0412' });
    expect(inv.lines).toHaveLength(1);

    // The original stays viewable, as uploaded, page by page.
    const page = await app.server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/pages/1`,
    });
    expect([page.statusCode, page.headers['content-type']]).toEqual([200, 'image/png']);
    expect(page.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect(
      (await app.server.inject({ method: 'GET', url: `/api/v1/documents/${documentId}/pages/2` }))
        .statusCode,
    ).toBe(404);
    // Everything else printed is kept, as printed.
    const doc = (
      await app.server.inject({ method: 'GET', url: `/api/v1/documents/${documentId}` })
    ).json<{ extraction: { pages: number; otherFields: unknown[] } }>();
    expect(doc.extraction).toMatchObject({
      pages: 1,
      otherFields: [{ label: 'Terms of Payment', value: '30 days', page: 1 }],
    });

    // The log says how it was read, with counts only: no values, no key.
    const read = logLines.find((l) => l.msg === 'invoice read' && l.invoiceId === invoiceId);
    expect(read).toMatchObject({
      component: 'reader',
      mime: 'application/pdf',
      extractor: 'ai_vision',
      pages: 1,
      readers: ['ai_vision'],
      textPages: 0,
      imagePages: 1,
      rendered: true,
      lines: 1,
      otherFields: 1,
    });
    expect(read?.fieldsRead).toBeGreaterThan(10);
    expect(
      logLines.find((l) => l.msg === 'invoice checked' && l.invoiceId === invoiceId),
    ).toMatchObject({ state: 'COMMITTING' }); // checked; the ERP write is the next job
    const everything = JSON.stringify(logLines);
    for (const secret of ['test-key-0123456789abcdef', '29AABCM2468K1Z4', 'Malabar', '68,440'])
      expect(everything).not.toContain(secret);
  });
});
