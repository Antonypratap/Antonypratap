import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ApiChallengeState } from '@veyra/shared';
import * as t from '../db/schema';
import { createTestApp } from '../test/app';
import { testSession } from '../test/auth';
import { DEMO_NOW } from '../test/harness';
import type { EmailMessage, EmailSender } from './email';

/**
 * The 10 Invoice Challenge, end to end against the real pipeline: synthetic invoices (made-up
 * suppliers and amounts; never a real invoice), the real reader, the real checks, each challenge
 * in its own workspace. No result here is scripted: the expectations are what the engine finds.
 */
type App = Awaited<ReturnType<typeof createTestApp>>;
let app: App | undefined;
let dir = '';
afterEach(async () => {
  await app?.close(0);
  app = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
const doc = (name: string) => new Uint8Array(readFileSync(new URL(name, DOCS)));
const RECORDS = readFileSync(
  new URL('../../../../fixtures/imports/Demo-Business-Records.xlsx', import.meta.url),
);
/** The demo company's GSTIN (the synthetic invoices are billed to it). */
const BUYER = '29AAACS1111A1Z6';

let now = new Date(DEMO_NOW);
const sent: EmailMessage[] = [];
const email: EmailSender = {
  configured: true,
  send: (m) => {
    sent.push(m);
    return Promise.resolve('sent');
  },
};

async function open(opts: { challenge?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'veyra-challenge-'));
  now = new Date(DEMO_NOW);
  sent.length = 0;
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => now,
    ...(opts.challenge === false ? {} : { challenge: { retentionDays: 30, dailyLimit: 5 }, email }),
    auth: { publicOrigins: ['https://challenge.example.com'] },
  });
  return app;
}

const DETAILS = {
  companyName: 'Example Brewing Co',
  contactName: 'Asha',
  email: 'finance@example.com',
  outlets: 3,
  consent: true,
};

const H = 'x-veyra-challenge';
const PAGE = { 'x-veyra-challenge-request': '1' };
async function start(a: App, details: Record<string, unknown> = DETAILS) {
  const res = await a.anonymous({
    method: 'POST',
    url: '/api/v1/challenge',
    payload: details,
    headers: PAGE,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ token: string; state: ApiChallengeState }>();
}
function multipart(filename: string, bytes: Uint8Array, type = 'application/pdf') {
  const boundary = '----veyra-challenge';
  return {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
async function send(a: App, token: string, url: string, filename: string, bytes: Uint8Array) {
  const body = multipart(filename, bytes);
  return a.anonymous({
    method: 'POST',
    url,
    payload: body.payload,
    headers: { 'content-type': body['content-type'], [H]: token },
  });
}
const upload = (a: App, token: string, name: string, bytes = doc(name)) =>
  send(a, token, '/api/v1/challenge/me/invoices', name, bytes);
const get = async (a: App, token: string) => {
  const res = await a.anonymous({ url: '/api/v1/challenge/me', headers: { [H]: token } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ApiChallengeState>();
};
const post = (a: App, token: string, url: string, payload: Record<string, unknown> = {}) =>
  a.anonymous({ method: 'POST', url, payload, headers: { [H]: token } });

/** Waits until the engine has finished with every invoice (polling, as the browser does). */
async function until(
  a: App,
  token: string,
  done: (s: ApiChallengeState) => boolean,
  ms = 90_000,
): Promise<ApiChallengeState> {
  const end = Date.now() + ms;
  for (;;) {
    const s = await get(a, token);
    if (done(s)) return s;
    if (Date.now() > end)
      throw new Error(`timed out: ${JSON.stringify(s.invoices.map((i) => i.phase))}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const allRead = (s: ApiChallengeState) =>
  s.invoices.length > 0 && s.invoices.every((i) => i.phase === 'read' || i.phase === 'failed');
const byFile = (s: ApiChallengeState, f: string) => {
  const i = s.invoices.find((x) => x.filename === f);
  if (!i) throw new Error(`no ${f}`);
  return i;
};

describe('10 Invoice Challenge: access', () => {
  it('does not exist unless enabled', async () => {
    const a = await open({ challenge: false });
    const res = await a.anonymous({
      method: 'POST',
      url: '/api/v1/challenge',
      payload: DETAILS,
      headers: PAGE,
    });
    expect(res.statusCode).toBe(404);
  });

  it('needs consent and valid details; a challenge is reached only with its own token', async () => {
    const a = await open();
    expect(
      (
        await a.anonymous({
          method: 'POST',
          url: '/api/v1/challenge',
          payload: { ...DETAILS, consent: false },
          headers: PAGE,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await a.anonymous({
          method: 'POST',
          url: '/api/v1/challenge',
          payload: { ...DETAILS, email: 'not-an-email' },
          headers: PAGE,
        })
      ).statusCode,
    ).toBe(422);
    const one = await start(a);
    expect(one.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(one.state).toMatchObject({ status: 'collecting', companyName: 'Example Brewing Co' });
    // Only the hash is stored.
    const row = (await a.veyra.db.select().from(t.challenges))[0];
    expect(row?.tokenHash).not.toContain(one.token);
    expect(JSON.stringify(row)).not.toContain(one.token);
    // The browser holds the token in an HttpOnly cookie scoped to the challenge API.
    const created = await a.anonymous({
      method: 'POST',
      url: '/api/v1/challenge',
      payload: { ...DETAILS, email: 'second@example.com' },
      headers: PAGE,
    });
    const cookie = String(created.headers['set-cookie']);
    expect(cookie).toMatch(/veyra_challenge=[A-Za-z0-9_-]{43}/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/challenge/);
    const jar = cookie.split(';')[0] ?? '';
    expect(
      (await a.anonymous({ url: '/api/v1/challenge/me', headers: { cookie: jar } })).statusCode,
    ).toBe(200);
    // A change made with the cookie alone (a cross-site request) is refused.
    const forged = await a.anonymous({
      method: 'POST',
      url: '/api/v1/challenge/me/start',
      payload: { gstin: BUYER },
      headers: { cookie: jar },
    });
    expect(forged.statusCode).toBe(403);
    const startNoHeader = await a.anonymous({
      method: 'POST',
      url: '/api/v1/challenge',
      payload: DETAILS,
    });
    expect(startNoHeader.statusCode).toBe(403);
    // No token, a wrong token: nothing.
    expect((await a.anonymous({ url: '/api/v1/challenge/me' })).statusCode).toBe(404);
    expect(
      (await a.anonymous({ url: '/api/v1/challenge/me', headers: { [H]: 'x'.repeat(43) } }))
        .statusCode,
    ).toBe(404);
  }, 60_000);

  it('one company never reaches another’s invoices or pages', async () => {
    const a = await open();
    const A = await start(a);
    const B = await start(a, { ...DETAILS, companyName: 'Other Foods', email: 'ap@other.example' });
    expect((await upload(a, A.token, 'D01-clean-text.pdf')).statusCode).toBe(201);
    const sa = await until(a, A.token, allRead);
    const sb = await get(a, B.token);
    expect(sb.invoices).toEqual([]);
    const docId = sa.invoices[0]?.documentId ?? '';
    const page = (token: string) =>
      a.anonymous({
        url: `/api/v1/challenge/me/documents/${docId}/pages/1`,
        headers: { [H]: token },
      });
    expect((await page(A.token)).statusCode).toBe(200);
    expect((await page(B.token)).statusCode).toBe(404);
    // The same file in another company's challenge is not a duplicate there (separate workspaces).
    expect((await upload(a, B.token, 'D01-clean-text.pdf')).statusCode).toBe(201);
    // Nothing reaches the deployment's own workspace.
    expect(await a.veyra.db.select().from(t.invoices)).toEqual([]);
  }, 120_000);
});

describe('10 Invoice Challenge: the journey against records', () => {
  it('reads at upload, waits for the records, then the real checks find what is there', async () => {
    const a = await open();
    const { token } = await start(a);
    for (const f of [
      'D01-clean-text.pdf',
      'D07-quantity-mismatch.pdf',
      'D08-rate-mismatch.pdf',
      'D12-missing-receipt.pdf',
      'D06-unreadable-total.pdf',
    ])
      expect((await upload(a, token, f)).statusCode).toBe(201);

    // Read, and held: supplier and number shown, checks not started.
    const read = await until(a, token, allRead);
    const d08 = byFile(read, 'D08-rate-mismatch.pdf');
    expect(d08.phase).toBe('read');
    expect(d08.supplier).toBeTruthy();
    expect(d08.number).toBeTruthy();
    expect(d08.stages[0]).toMatchObject({ key: 'read', status: 'done' });
    expect(d08.stages.slice(1).every((s) => s.status === 'waiting')).toBe(true);
    expect(read.gstinCandidates[0]).toEqual({ gstin: BUYER, invoices: 5 });

    // Records: a PDF is not read as records; the template workbook is.
    const pdfRecords = await send(
      a,
      token,
      '/api/v1/challenge/me/records',
      'po.pdf',
      doc('D01-clean-text.pdf'),
    );
    expect(pdfRecords.statusCode).toBe(422);
    const rec = await send(
      a,
      token,
      '/api/v1/challenge/me/records',
      'records.xlsx',
      new Uint8Array(RECORDS),
    );
    expect(rec.statusCode, rec.body).toBe(200);
    expect(rec.json<ApiChallengeState>().records.files[0]?.summary).toMatch(/supplier/);

    expect(
      (await post(a, token, '/api/v1/challenge/me/start', { gstin: 'NOT-A-GSTIN' })).statusCode,
    ).toBe(422);
    expect((await post(a, token, '/api/v1/challenge/me/start', { gstin: BUYER })).statusCode).toBe(
      200,
    );
    const done = await until(a, token, (s) => s.status === 'complete');

    expect(byFile(done, 'D01-clean-text.pdf')).toMatchObject({
      outcome: 'cleared',
      basis: 'records',
    });
    expect(byFile(done, 'D07-quantity-mismatch.pdf')).toMatchObject({
      outcome: 'review',
      finding: { type: 'quantity' },
    });
    expect(byFile(done, 'D08-rate-mismatch.pdf')).toMatchObject({
      outcome: 'review',
      finding: { type: 'rate' },
    });
    expect(byFile(done, 'D12-missing-receipt.pdf')).toMatchObject({
      outcome: 'confirm',
      finding: { type: 'receipt' },
    });
    expect(byFile(done, 'D06-unreadable-total.pdf')).toMatchObject({ outcome: 'confirm' });

    // Steps from the engine's records: the rate invoice's records and checks really ran.
    const steps = Object.fromEntries(
      byFile(done, 'D08-rate-mismatch.pdf').stages.map((s) => [s.key, s]),
    );
    expect(steps.records?.status).toBe('done');
    expect(steps.calculations?.status).toBe('done');
    // Evidence: the invoice's own value, with its place on the uploaded page.
    const ev = byFile(done, 'D08-rate-mismatch.pdf').finding?.evidence ?? [];
    expect(ev.some((e) => e.source === 'invoice' && e.page === 1 && e.bbox)).toBe(true);
    expect(ev.some((e) => e.source === 'erp')).toBe(true);

    // The numbers are the invoices' own: nothing estimated.
    const s = done.summary;
    const total = (fs: string[]) =>
      fs.reduce((sum, f) => sum + (byFile(done, f).totalPaise ?? 0), 0);
    expect(s).toMatchObject({
      checked: 5,
      cleared: 1,
      clearedAgainstRecords: 1,
      attention: 4,
      review: 2,
      confirm: 2,
      failed: 0,
    });
    expect(s?.reviewValuePaise).toBe(
      total([
        'D07-quantity-mismatch.pdf',
        'D08-rate-mismatch.pdf',
        'D12-missing-receipt.pdf',
        'D06-unreadable-total.pdf',
      ]),
    );
    expect(s?.totalPaise).toBe(s ? total(done.invoices.map((i) => i.filename)) : -1);

    // The lead record (Control Centre) holds the summary, never document contents.
    const row = (await a.veyra.db.select().from(t.challenges))[0];
    expect(row).toMatchObject({
      status: 'complete',
      cleared: 1,
      attention: 4,
      invoicesSubmitted: 5,
      recordFiles: 1,
      gstin: BUYER,
    });

    // The completion e-mail: the summary and a private link that opens the results.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('finance@example.com');
    expect(sent[0]?.text).toContain('5 invoices checked');
    expect(row?.emailStatus).toBe('sent');
    const link = /#access=([A-Za-z0-9_-]{43})/.exec(sent[0]?.text ?? '')?.[1] ?? '';
    expect((await get(a, link)).id).toBe(done.id);
    const claimed = await a.anonymous({
      method: 'POST',
      url: '/api/v1/challenge/claim',
      payload: { token: link },
      headers: PAGE,
    });
    expect(claimed.statusCode).toBe(200);
    expect(String(claimed.headers['set-cookie'])).toMatch(/veyra_challenge=/);

    // The report: a real PDF, counted.
    const pdf = await a.anonymous({
      url: '/api/v1/challenge/me/report.pdf',
      headers: { [H]: token },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const after = (await a.veyra.db.select().from(t.challenges))[0];
    expect(after?.reportDownloads).toBe(1);
    expect(after?.reportGeneratedAt).not.toBeNull();
  }, 180_000);
});

describe('10 Invoice Challenge: without records, failures, limits', () => {
  it('without records: invoice checks only, said as such; failures explained, retryable, removable', async () => {
    const a = await open();
    const { token } = await start(a);
    expect((await upload(a, token, 'D01-clean-text.pdf')).statusCode).toBe(201);
    // The same invoice again, as a second copy of the file (not byte-identical).
    const copy = Buffer.concat([
      Buffer.from(doc('D01-clean-text.pdf')),
      Buffer.from('\n% copy\n%%EOF\n'),
    ]);
    expect((await upload(a, token, 'D01-copy.pdf', new Uint8Array(copy))).statusCode).toBe(201);
    const damaged = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Garbage >>\ntrailer\n%%EOF\n');
    expect((await upload(a, token, 'scan.pdf', damaged)).statusCode).toBe(201);
    // Not an invoice file at all: refused at once, with the reason.
    const txt = await upload(a, token, 'notes.pdf', new TextEncoder().encode('hello'));
    expect(txt.statusCode).toBeGreaterThanOrEqual(400);

    const read = await until(a, token, allRead);
    const failed = byFile(read, 'scan.pdf');
    expect(failed).toMatchObject({ outcome: 'failed', canRetry: true, canRemove: true });
    expect(failed.failure?.reason).toBeTruthy();
    expect(
      (await post(a, token, `/api/v1/challenge/me/invoices/${failed.id}/remove`)).statusCode,
    ).toBe(200);
    expect((await get(a, token)).invoices.map((i) => i.filename)).not.toContain('scan.pdf');

    expect((await post(a, token, '/api/v1/challenge/me/start', { gstin: BUYER })).statusCode).toBe(
      200,
    );
    const done = await until(a, token, (s) => s.status === 'complete');
    const pair = [byFile(done, 'D01-clean-text.pdf'), byFile(done, 'D01-copy.pdf')];
    // The same invoice twice is caught: never both cleared. (Which copy is flagged depends on
    // which was checked first; the engine's duplicate rule is unchanged.)
    expect(pair.some((i) => i.outcome === 'review' && i.finding?.type === 'duplicate')).toBe(true);
    expect(pair.filter((i) => i.outcome === 'cleared').length).toBeLessThanOrEqual(1);
    // Nothing to compare with: a cleared invoice passed its own checks, and it says so.
    for (const i of pair.filter((x) => x.outcome === 'cleared')) {
      expect(i.basis).toBe('invoice');
      expect(i.stages.find((s) => s.key === 'records')).toMatchObject({
        status: 'skipped',
        note: 'Not checked: no records provided',
      });
    }
    expect(done.summary?.clearedAgainstRecords).toBe(0);
  }, 180_000);

  it('ten invoices at most; a daily cap; follow-up audited; documents deleted after the retention period', async () => {
    const a = await open();
    const { token, state } = await start(a);
    const ch = (await a.veyra.db.select().from(t.challenges))[0];
    for (let i = 0; i < 10; i++) {
      const bytes = Buffer.concat([
        Buffer.from(doc('D01-clean-text.pdf')),
        Buffer.from(`\n% ${i}\n%%EOF\n`),
      ]);
      expect((await upload(a, token, `copy-${i}.pdf`, new Uint8Array(bytes))).statusCode).toBe(201);
    }
    const eleventh = await upload(a, token, 'D08-rate-mismatch.pdf');
    expect(eleventh.statusCode).toBe(409);

    // Daily cap (5 in this test, including the one above).
    for (let i = 0; i < 4; i++) await start(a, { ...DETAILS, email: `a${i}@example.com` });
    const capped = await a.anonymous({
      method: 'POST',
      url: '/api/v1/challenge',
      payload: DETAILS,
      headers: PAGE,
    });
    expect(capped.statusCode).toBe(429);

    // The Veyrafy team sees it (never the token); a customer never does.
    const operator = await testSession(a, { role: 'VEYRA_ADMIN' });
    const list = await a.anonymous({
      url: '/api/v1/ops/centre/challenges',
      headers: operator.headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toMatch(/tokenHash|token_hash|linkTokenHash/);
    expect(list.json<{ challenges: { id: string }[] }>().challenges.map((c) => c.id)).toContain(
      state.id,
    );
    expect(
      (await a.anonymous({ url: '/api/v1/ops/centre/challenges', headers: a.session.headers }))
        .statusCode,
    ).toBe(403);
    const fu = await a.anonymous({
      method: 'POST',
      url: `/api/v1/ops/centre/challenges/${state.id}/follow-up`,
      headers: operator.headers,
      payload: { followUp: 'contacted', reason: 'Called the finance head' },
    });
    expect(fu.statusCode).toBe(200);
    const events = await a.veyra.db.select().from(t.commercialEvents);
    expect(events.map((e) => [e.event, e.subject])).toEqual([
      ['challenge.follow_up_changed', `challenge:${state.id}`],
    ]);

    // Retention: after the period the workspace is deleted; the summary stays.
    const ws = join(dir, 'challenges', ch?.id ?? '');
    expect(existsSync(ws)).toBe(true);
    now = new Date(DEMO_NOW.getTime() + 31 * 86_400_000);
    await a.challenge?.tick();
    expect(existsSync(ws)).toBe(false);
    const purged = (
      await a.veyra.db.select().from(t.challenges).where(eq(t.challenges.id, state.id))
    )[0];
    expect(purged).toMatchObject({ status: 'purged' });
    expect((await get(a, token)).invoices).toEqual([]);
    expect((await upload(a, token, 'D08-rate-mismatch.pdf')).statusCode).toBe(409);
  }, 180_000);
});
