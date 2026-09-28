import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderScenario, scenarioById } from '@veyra/extractor';
import type { ApiInbox, ApiInvoiceDetail, ApiQuestion, ApiAuditEntry } from '@veyra/shared';
import { PACKAGE_NAME, createApp } from './index';
import { DEMO_NOW } from './test/harness';

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-http-'));
  app = await createApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
  });
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function multipart(filename: string, bytes: Uint8Array, mime: string) {
  const boundary = '----veyra-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(id: string) {
  const s = scenarioById(id);
  if (!s) throw new Error(id);
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/v1/documents',
    ...multipart(s.file, renderScenario(s), s.kind === 'pdf' ? 'application/pdf' : 'image/png'),
  });
  return res;
}

const get = async <T>(url: string): Promise<T> =>
  (await app.server.inject({ method: 'GET', url })).json<T>();

describe('@veyra/api', () => {
  it('exposes its package name and health', async () => {
    expect(PACKAGE_NAME).toBe('@veyra/api');
    expect(await get('/api/v1/health')).toMatchObject({ ok: true, extractor: { id: 'local_ocr' } });
  });
});

describe('the vertical slice over HTTP', () => {
  it('upload → processing → question → answer → resume → commit → VERIFIED_PENDING_PAYMENT → audit', async () => {
    // 1. Upload
    const res = await upload('S08');
    expect(res.statusCode).toBe(201);
    const { invoiceId } = res.json<{ invoiceId: string }>();
    // 2. It enters processing
    let inbox = await get<ApiInbox>('/api/v1/invoices');
    expect(inbox.invoices[0]).toMatchObject({
      id: invoiceId,
      state: 'UPLOADED',
      status: 'processing',
    });

    // 3–5. Extraction, resolution, a question
    await app.runner.drain();
    inbox = await get<ApiInbox>('/api/v1/invoices');
    expect(inbox.counts).toMatchObject({ received: 1, needsYou: 1 });
    const [q] = await get<ApiQuestion[]>('/api/v1/questions');
    expect(q).toMatchObject({
      code: 'CA_GRN',
      summary: 'Receipt not recorded',
      invoice: { number: 'APX-7790' },
    });
    expect(q?.options.find((o) => o.id === 'confirm')?.input).toMatchObject({ kind: 'grn' });

    // Bad input is refused by the server, not trusted.
    const bad = await app.server.inject({
      method: 'POST',
      url: `/api/v1/questions/${q?.id}/answer`,
      payload: {
        optionId: 'confirm',
        input: { grnDate: '2026-09-20', lines: [{ poLineNo: 1, received: '50', accepted: '51' }] },
      },
    });
    expect(bad.statusCode).toBe(422);

    // 6. The user answers
    const ok = await app.server.inject({
      method: 'POST',
      url: `/api/v1/questions/${q?.id}/answer`,
      payload: {
        optionId: 'confirm',
        input: { grnDate: '2026-09-20', lines: [{ poLineNo: 1, received: '50', accepted: '50' }] },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'MATCHING' });

    // 7–10. Resume, validate, commit, verified
    await app.runner.drain();
    const detail = await get<ApiInvoiceDetail>(`/api/v1/invoices/${invoiceId}`);
    expect(detail).toMatchObject({
      state: 'VERIFIED_PENDING_PAYMENT',
      status: 'ready',
      question: null,
    });
    expect(detail.checks.every((c) => c.outcome === 'pass' || c.outcome === 'not_applicable')).toBe(
      true,
    );
    expect(detail.erp.records).toEqual([
      expect.stringMatching(/^Goods receipt GRN\/2026-27\/\d+ recorded$/),
    ]);
    expect(await get<{ id: string }[]>('/api/v1/erp/purchase-invoices')).toHaveLength(1);
    expect((await get<ApiQuestion[]>('/api/v1/questions')).length).toBe(0);
    expect((await get<ApiQuestion[]>('/api/v1/questions?status=answered'))[0]?.answer?.label).toBe(
      'Yes, record the receipt',
    );

    // 11. Audit shows everything, Veyra vs You
    const trail = await get<ApiAuditEntry[]>(`/api/v1/audit?invoiceId=${invoiceId}`);
    expect(trail.map((e) => `${e.by}: ${e.title}`)).toEqual([
      'You: Uploaded invoice',
      'Veyra: Read invoice',
      'Veyra: Matched supplier',
      'Veyra: Matched purchase order',
      'Veyra: Found something to check',
      'Veyra: Asked you',
      'You: Confirmed goods receipt',
      'Veyra: Matched supplier',
      'Veyra: Matched purchase order',
      'Veyra: Validated invoice',
      'Veyra: Validated ERP references',
      'Veyra: Recorded in your ERP',
      'Veyra: Recorded ERP transaction',
      'Veyra: Ready for payment',
    ]);
  });

  it('a clean invoice needs nobody', async () => {
    const { invoiceId } = (await upload('S01')).json<{ invoiceId: string }>();
    await app.runner.drain();
    expect(await get<ApiInvoiceDetail>(`/api/v1/invoices/${invoiceId}`)).toMatchObject({
      status: 'handled',
      note: 'Matched to PO-2026-0101',
    });
  });

  it('rejects explicitly; duplicate files are 409; non-invoices are 415', async () => {
    const { invoiceId } = (await upload('S09')).json<{ invoiceId: string }>();
    await app.runner.drain();
    const again = await upload('S09');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      error: { code: 'DUPLICATE_UPLOAD', details: { invoiceId } },
    });
    const junk = await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      ...multipart('x.pdf', new TextEncoder().encode('not a pdf'), 'application/pdf'),
    });
    expect(junk.statusCode).toBe(415);
    const [q] = await get<ApiQuestion[]>('/api/v1/questions');
    await app.server.inject({
      method: 'POST',
      url: `/api/v1/questions/${q?.id}/answer`,
      payload: { optionId: 'reject' },
    });
    const detail = await get<ApiInvoiceDetail>(`/api/v1/invoices/${invoiceId}`);
    expect(detail).toMatchObject({ state: 'REJECTED', status: 'rejected' });
    const answered = await app.server.inject({
      method: 'POST',
      url: `/api/v1/questions/${q?.id}/answer`,
      payload: { optionId: 'reject' },
    });
    expect(answered.statusCode).toBe(409);
  });

  it('serves the ERP read-only, through the connector', async () => {
    expect(await get<unknown[]>('/api/v1/erp/vendors')).toHaveLength(7);
    expect(await get<unknown[]>('/api/v1/erp/purchase-orders')).toHaveLength(13);
    expect(
      (await app.server.inject({ method: 'POST', url: '/api/v1/erp/vendors' })).statusCode,
    ).toBe(404);
  });

  it('validates ids and bodies', async () => {
    expect(
      (await app.server.inject({ method: 'GET', url: '/api/v1/invoices/not-an-id' })).statusCode,
    ).toBe(422);
    expect(
      (
        await app.server.inject({
          method: 'GET',
          url: '/api/v1/invoices/01K00000000000000000000000',
        })
      ).statusCode,
    ).toBe(404);
  });
});
