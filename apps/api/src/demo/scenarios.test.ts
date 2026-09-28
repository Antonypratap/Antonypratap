import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiAuditEntry,
  ApiDemoScenario,
  ApiInbox,
  ApiInvoiceDetail,
  ApiQuestion,
} from '@veyra/shared';
import { createApp } from '../app';
import { DEMO_NOW } from '../test/harness';

/**
 * Phase 3E: the demo scenarios drive the real workflow (real extractor, unchanged engine), and
 * what the prospect sees is written in business language.
 */
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-scenarios-'));
  app = await createApp({
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
const reset = async () => {
  await app.server.inject({ method: 'POST', url: '/api/v1/dev/reset', payload: { erp: 'demo' } });
  app.runner.stop();
};
beforeEach(reset);

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
const audit = async (id: string) =>
  (await get<ApiAuditEntry[]>(`/api/v1/audit?invoiceId=${id}`)).map((e) => `${e.by}: ${e.title}`);

/** Machine-readable codes must never reach what a person reads. */
const CODES =
  /\b(MD_FIELD|AM_[A-Z_]+|VF_R\d+|CA_[A-Z]+|BD_[A-Z_]+|MISSING_DATA|AMBIGUOUS_MATCH|VALIDATION_FAILURE|CREATION_APPROVAL|BUSINESS_DECISION|NEEDS_INPUT|VERIFIED_PENDING_PAYMENT)\b/;
const readable = (q: ApiQuestion) =>
  [
    q.summary,
    q.evidence,
    q.headline,
    ...q.why,
    ...q.facts.flatMap((f) => [f.label, f.value]),
    ...q.options.flatMap((o) => [o.label, o.result]),
  ].join(' | ');

describe('demo scenario launcher', () => {
  it('lists seven scenarios in plain language', async () => {
    const list = await get<ApiDemoScenario[]>('/api/v1/dev/scenarios');
    expect(list.map((s) => s.title)).toEqual([
      'Clean invoice',
      'Missing goods receipt',
      'Ambiguous supplier',
      'Quantity mismatch',
      'Rate mismatch',
      'Photo needs confirmation',
      'Two invoices in one file',
    ]);
    for (const s of list) expect(`${s.title} ${s.story}`).not.toMatch(CODES);
  });

  it('clean invoice: handled by Veyra with evidence; verified, pending payment; no one asked', async () => {
    const id = await start('clean');
    const inv = await detail(id);
    expect(inv).toMatchObject({ state: 'VERIFIED_PENDING_PAYMENT', status: 'handled' });
    expect(await question(id)).toBeUndefined();
    expect(inv.erp).toMatchObject({
      vendor: 'Shakti Steel Suppliers Pvt Ltd (V001)',
      poNumber: 'PO-2026-0110',
      receipts: [{ number: 'GRN-2026-0209', byYou: false }],
      purchaseInvoice: { status: 'verified_pending_payment', lines: 1, totalPaise: 737_500 },
    });
    // Payment is never executed: the only ERP status that exists is "verified, pending payment".
    const recorded = await get<{ status: string }[]>('/api/v1/erp/purchase-invoices');
    expect(recorded.map((r) => r.status)).toEqual(['verified_pending_payment']);
  });

  it('missing goods receipt: asks "Did the goods arrive?"; your receipt → re-check → ready', async () => {
    const id = await start('missing-receipt');
    const q = await question(id);
    expect(q).toMatchObject({
      code: 'CA_GRN',
      kind: 'CREATION_APPROVAL',
      headline: 'Did the goods arrive?',
      evidence: 'Found the supplier and PO-2026-0104, but no goods receipt yet',
    });
    expect(q?.options.map((o) => o.label)).toEqual([
      'Yes, record the receipt',
      'No, reject this invoice',
    ]);
    await answer(q as ApiQuestion, 'confirm', {
      grnDate: '2026-09-26',
      lines: [{ poLineNo: 1, received: '50', accepted: '50' }],
    });
    const inv = await detail(id);
    expect(inv).toMatchObject({ state: 'VERIFIED_PENDING_PAYMENT', status: 'ready' });
    expect(inv.erp.receipts).toEqual([
      expect.objectContaining({ byYou: true, date: '2026-09-26' }),
    ]);
    expect(await audit(id)).toEqual([
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

  it('ambiguous supplier: shows both candidates with GSTINs; your choice → re-check → ready', async () => {
    const id = await start('ambiguous-supplier');
    const q = await question(id);
    expect(q).toMatchObject({
      kind: 'AMBIGUOUS_MATCH',
      headline: 'Which supplier sent this invoice?',
    });
    expect(q?.options.map((o) => o.label)).toEqual(
      expect.arrayContaining([
        'Vasudha Traders (29AAACV1234F1ZL)',
        'Vasudha Traders & Co (29AAJFV2222B1ZG)',
      ]),
    );
    await answer(q as ApiQuestion, 'vendor:V005');
    expect((await detail(id)).state).toBe('VERIFIED_PENDING_PAYMENT');
    expect(await audit(id)).toContain('You: Chose the supplier');
  });

  it('quantity mismatch: states invoiced vs ordered; no override option exists', async () => {
    const q = await question(await start('quantity-mismatch'));
    expect(q).toMatchObject({ kind: 'VALIDATION_FAILURE' });
    expect(q?.facts).toEqual([
      { label: 'Invoiced', value: '120 NOS', tone: 'attention' },
      { label: 'Ordered', value: '100 NOS' },
      { label: 'Already invoiced', value: '0 NOS' },
    ]);
    expect(q?.options.map((o) => o.id)).toEqual(['set:lines[1].qtyMilli', 'recheck', 'reject']);
  });

  it('rate mismatch: invoice rate, PO rate and the difference; no override option exists', async () => {
    const q = await question(await start('rate-mismatch'));
    expect(q?.facts).toEqual([
      { label: 'Invoice price', value: '₹150.00 per NOS', tone: 'attention' },
      { label: 'PO-2026-0111 price', value: '₹145.00 per NOS' },
      { label: 'Difference', value: '₹5.00 per NOS' },
    ]);
    expect(q?.options.map((o) => o.id)).toEqual([
      'set:lines[1].unitPricePaise',
      'recheck',
      'reject',
    ]);
  });

  it('photo needs confirmation: says what Veyra read and why it needs you; confidence is not inflated', async () => {
    const id = await start('unclear-scan');
    const q = await question(id);
    expect(q).toMatchObject({
      code: 'MD_FIELD',
      kind: 'MISSING_DATA',
      paths: ['header.buyerGstin'],
    });
    expect(q?.facts[0]).toMatchObject({ label: 'Veyra read', value: '29AAACS1111A176' });
    expect(q?.evidence).toBe(
      'Veyra read 29AAACS1111A176, but not clearly, and that is not a valid GSTIN on the invoice',
    );
    expect(q?.why[0]).toMatch(/not clear here/);
    // A misread that is not a valid value cannot be "confirmed": it must be entered.
    expect(q?.options.map((o) => o.id)).toEqual(['set:header.buyerGstin', 'reject']);
    await answer(q as ApiQuestion, 'set:header.buyerGstin', '29AAACS1111A1Z6');
    expect((await detail(id)).state).toBe('NEEDS_INPUT'); // the next unclear value is asked in turn
  }, 60_000);

  it('two invoices in one file: stopped; one file per invoice; never merged', async () => {
    const id = await start('two-invoices');
    const inv = await detail(id);
    expect(inv.state).toBe('FAILED');
    expect(inv.failure?.reason).toMatch(/Upload each invoice as its own file/);
    expect(inv.lines).toEqual([]);
  });

  it('no question a prospect sees carries a machine code', async () => {
    for (const key of [
      'missing-receipt',
      'ambiguous-supplier',
      'quantity-mismatch',
      'rate-mismatch',
    ])
      await start(key);
    const open = await get<ApiQuestion[]>('/api/v1/questions');
    expect(open).toHaveLength(4);
    for (const q of open) expect(readable(q), q.code).not.toMatch(CODES);
    const inbox = await get<ApiInbox>('/api/v1/invoices');
    for (const i of inbox.invoices)
      expect(`${i.question?.summary} ${i.question?.evidence} ${i.question?.headline}`).not.toMatch(
        CODES,
      );
  });

  it('starting a scenario again opens the same invoice instead of duplicating it', async () => {
    const first = await start('clean');
    const again = await app.server.inject({ method: 'POST', url: '/api/v1/dev/scenarios/clean' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ invoiceId: first, existing: true });
    expect((await get<ApiInbox>('/api/v1/invoices')).counts.received).toBe(1);
    expect(
      (await app.server.inject({ method: 'POST', url: '/api/v1/dev/scenarios/nope' })).statusCode,
    ).toBe(404);
  });
});

describe('reset restores the known demo state', () => {
  it('clears invoices, questions, decisions, audit and created ERP records; scenarios start again', async () => {
    await start('clean');
    const q = await question(await start('missing-receipt'));
    await answer(q as ApiQuestion, 'confirm', {
      grnDate: '2026-09-26',
      lines: [{ poLineNo: 1, received: '50', accepted: '50' }],
    });
    await start('rate-mismatch');
    expect((await get<unknown[]>('/api/v1/erp/grns')).length).toBe(13);

    await reset();
    const inbox = await get<ApiInbox>('/api/v1/invoices');
    expect(inbox.counts).toMatchObject({ received: 0, needsYou: 0, handled: 0, decidedByYou: 0 });
    expect(await get<unknown[]>('/api/v1/questions')).toEqual([]);
    expect(await get<unknown[]>('/api/v1/questions?status=answered')).toEqual([]);
    expect(await get<unknown[]>('/api/v1/audit')).toEqual([]);
    expect(await get<unknown[]>('/api/v1/erp/purchase-invoices')).toEqual([]);
    expect((await get<unknown[]>('/api/v1/erp/grns')).length).toBe(12); // the seed's receipts only
    expect((await get<unknown[]>('/api/v1/erp/vendors')).length).toBe(7);

    expect((await detail(await start('clean'))).state).toBe('VERIFIED_PENDING_PAYMENT');
  });
});

describe('outside the demo', () => {
  it('scenario and reset routes do not exist', async () => {
    const d = mkdtempSync(join(tmpdir(), 'veyra-nodemo-'));
    const plain = await createApp({
      dataDir: d,
      demo: false,
      allowFixtureExtractor: false,
      nodeEnv: 'test',
      clock: () => DEMO_NOW,
    });
    try {
      for (const [method, url] of [
        ['GET', '/api/v1/dev/scenarios'],
        ['POST', '/api/v1/dev/scenarios/clean'],
        ['POST', '/api/v1/dev/reset'],
      ] as const)
        expect((await plain.server.inject({ method, url })).statusCode, url).toBe(404);
    } finally {
      await plain.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
