import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiInbox, ApiInvoiceSummary } from '@veyra/shared';
import { api, ApiError } from './api/client';
import { formatDate, greetingFor } from './format';
import { hrefFor, parseHash } from './router';
import { attentionQueue, nextInQueue } from './state/data';
import { STATUS_LABEL, STATUS_TONE } from './state/status';

const summary = (
  id: string,
  status: ApiInvoiceSummary['status'],
  receivedAt: string,
): ApiInvoiceSummary => ({
  id,
  documentId: id,
  state:
    status === 'attention'
      ? 'NEEDS_INPUT'
      : status === 'processing'
        ? 'MATCHING'
        : status === 'rejected'
          ? 'REJECTED'
          : 'VERIFIED_PENDING_PAYMENT',
  status,
  number: id,
  supplierName: 'Shakti Steel Suppliers Pvt Ltd',
  invoiceDate: '2026-09-15',
  totalPaise: 100,
  source: 'PDF',
  filename: `${id}.pdf`,
  receivedAt,
  updatedAt: receivedAt,
  question:
    status === 'attention'
      ? {
          id: `q-${id}`,
          kind: 'VALIDATION_FAILURE',
          summary: 'Price differs',
          evidence: '₹68.01 · ₹68.00',
          headline: 'The price on line 1 is different from PO-2026-0109.',
        }
      : null,
  decision: null,
  note: null,
  failure: null,
});

const inbox = (invoices: ApiInvoiceSummary[]): ApiInbox => ({
  counts: {
    received: invoices.length,
    needsYou: invoices.filter((i) => i.status === 'attention').length,
    processing: 0,
    handled: 0,
    decidedByYou: 0,
    ready: 0,
    rejected: 0,
  },
  invoices,
});

describe('the work queue comes from the server’s statuses', () => {
  const data = inbox([
    summary('b', 'attention', '2026-09-28T10:02:00Z'),
    summary('a', 'attention', '2026-09-28T10:01:00Z'),
    summary('c', 'handled', '2026-09-28T10:00:00Z'),
    summary('d', 'attention', '2026-09-28T10:03:00Z'),
  ]);

  it('is the invoices needing a decision, oldest first, and matches the needs-you count', () => {
    expect(attentionQueue(data).map((i) => i.id)).toEqual(['a', 'b', 'd']);
    expect(attentionQueue(data)).toHaveLength(data.counts.needsYou);
  });

  it('next question wraps around and is null when nothing else waits', () => {
    expect(nextInQueue(data, 'b')?.id).toBe('d');
    expect(nextInQueue(data, 'd')?.id).toBe('a');
    expect(nextInQueue(inbox([summary('a', 'attention', 'x')]), 'a')).toBeNull();
  });

  it('labels statuses in business language only', () => {
    expect(STATUS_LABEL).toEqual({
      attention: 'Needs your attention',
      processing: 'Processing',
      ready: 'Ready',
      handled: 'Handled',
      rejected: 'Rejected',
    });
    expect(STATUS_TONE.rejected).toBe('neutral');
    for (const label of Object.values(STATUS_LABEL))
      expect(label).not.toMatch(/AI|OCR|extract|confidence|model|workflow/i);
  });
});

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('validates responses against the shared contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ counts: {}, invoices: [] }), { status: 200 }),
      ),
    );
    await expect(api.inbox()).rejects.toThrow();
  });

  it('turns API errors into readable messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'DUPLICATE_UPLOAD', message: 'This exact file was already uploaded.' },
            }),
            { status: 409 },
          ),
      ),
    );
    await expect(api.upload(new File(['x'], 'x.pdf'))).rejects.toMatchObject({
      status: 409,
      code: 'DUPLICATE_UPLOAD',
      message: 'This exact file was already uploaded.',
    });
  });

  it('reports an unreachable API plainly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('failed'))),
    );
    await expect(api.inbox()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('routing', () => {
  it('parses product routes and leaves the homepage alone', () => {
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#product')).toEqual({ name: 'home' });
    expect(parseHash('#/app')).toEqual({ name: 'inbox' });
    expect(parseHash('#/app/questions')).toEqual({ name: 'questions' });
    expect(parseHash('#/app/invoices?attention')).toEqual({
      name: 'invoices',
      filter: 'attention',
    });
    expect(parseHash('#/app/invoices?bogus')).toEqual({ name: 'invoices', filter: 'all' });
    expect(parseHash('#/app/invoices/s10')).toEqual({ name: 'invoice', id: 's10' });
    expect(parseHash('#/app/erp/orders')).toEqual({ name: 'erp', tab: 'orders' });
    expect(parseHash('#/app/erp/nope')).toEqual({ name: 'erp', tab: 'vendors' });
    expect(parseHash('#/app/audit/s10')).toEqual({ name: 'audit', id: 's10' });
    expect(parseHash('#/app/unknown')).toEqual({ name: 'inbox' });
  });

  it('round-trips hrefs', () => {
    for (const hash of [
      '#/app/inbox',
      '#/app/questions',
      '#/app/invoices',
      '#/app/invoices?handled',
      '#/app/invoices/s10',
      '#/app/erp/items',
      '#/app/audit',
      '#/app/audit/s10',
    ]) {
      expect(hrefFor(parseHash(hash))).toBe(hash);
    }
  });
});

describe('formatting', () => {
  it('greets by time of day', () => {
    expect(greetingFor(8)).toBe('Good morning.');
    expect(greetingFor(13)).toBe('Good afternoon.');
    expect(greetingFor(20)).toBe('Good evening.');
    expect(greetingFor(3)).toBe('Good evening.');
  });

  it('formats dates the Indian business way', () => {
    expect(formatDate('2026-09-22')).toBe('22 Sep 2026');
  });
});

describe('amount in words', () => {
  it('writes Indian-system amounts as printed on invoices', async () => {
    const { amountInWords } = await import('./format');
    expect(amountInWords(1_475_000)).toBe('Rupees Fourteen Thousand Seven Hundred Fifty Only');
    expect(amountInWords(11_387_000)).toBe(
      'Rupees One Lakh Thirteen Thousand Eight Hundred Seventy Only',
    );
    expect(amountInWords(802_518)).toBe(
      'Rupees Eight Thousand Twenty Five and Eighteen Paise Only',
    );
    expect(amountInWords(1_234_567_800)).toBe(
      'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only',
    );
  });
});
