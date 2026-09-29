import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiInbox, ApiInvoiceSummary } from '@veyra/shared';
import { settledSince } from '../product/state/data';
import { Toaster } from './Toaster';
import { TIMEOUTS, clearToasts, dismiss, hold, notify, release, useToasts } from './toasts';

/** The store, read outside React (useSyncExternalStore's snapshot is the current array). */
let current: ReturnType<typeof useToasts> = [];
const snapshot = () => {
  // Render once to read the store through its hook.
  function Probe() {
    current = useToasts();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return current;
};

beforeEach(() => {
  vi.useFakeTimers();
  clearToasts();
});
afterEach(() => {
  clearToasts();
  vi.useRealTimers();
});

describe('toasts (Phase 7 UX)', () => {
  it('success and info dismiss themselves; attention later; errors stay until dismissed', () => {
    notify.answered();
    notify.reprocessing();
    notify.processed(0, 2);
    notify.offline();
    expect(snapshot().map((t) => t.kind)).toEqual(['success', 'info', 'attention', 'error']);
    vi.advanceTimersByTime(TIMEOUTS.success ?? 0);
    expect(snapshot().map((t) => t.kind)).toEqual(['attention', 'error']);
    vi.advanceTimersByTime((TIMEOUTS.attention ?? 0) - (TIMEOUTS.success ?? 0));
    expect(snapshot().map((t) => t.kind)).toEqual(['error']);
    vi.advanceTimersByTime(10 * 60_000);
    const error = snapshot()[0];
    expect(error?.kind).toBe('error');
    dismiss(error?.id ?? 0);
    expect(snapshot()).toEqual([]);
  });

  it('one toast per action: repeating it replaces the toast, never stacks a duplicate', () => {
    notify.uploaded(1);
    notify.uploaded(3);
    notify.offline();
    notify.offline(); // every failed poll during an outage
    notify.online(); // the same key: the outage toast becomes "restored"
    const toasts = snapshot();
    expect(toasts.map((t) => t.message)).toEqual([
      '3 invoices uploaded. Veyra is reading them.',
      'Connection restored.',
    ]);
  });

  it('a toast being read (hover or focus) does not vanish; it resumes afterwards', () => {
    notify.signedIn();
    const id = snapshot()[0]?.id ?? 0;
    hold(id);
    vi.advanceTimersByTime(60_000);
    expect(snapshot()).toHaveLength(1);
    release(id);
    vi.advanceTimersByTime(TIMEOUTS.success ?? 0);
    expect(snapshot()).toHaveLength(0);
  });

  it('never more than four at once (the oldest go first)', () => {
    notify.uploaded(1);
    notify.answered();
    notify.rejected();
    notify.reprocessing();
    notify.imported();
    notify.signedIn();
    expect(snapshot().map((t) => t.key)).toEqual(['reject', 'reprocess', 'import', 'session']);
  });

  it('messages carry no invoice or document data: fixed wording, counts only', () => {
    const all: string[] = [];
    for (const [name, fn] of Object.entries(notify)) {
      const args = name === 'importChecked' ? [false] : name === 'processed' ? [1, 1] : [1];
      (fn as (...a: unknown[]) => unknown)(...args);
      all.push(...snapshot().map((t) => t.message));
      clearToasts();
    }
    notify.processed(2, 1);
    all.push(...snapshot().map((t) => t.message));
    for (const m of all) {
      expect(m).not.toMatch(/\d{2}[A-Z]{5}\d{4}[A-Z]|₹|Rs\.|\.pdf|\.png|\.jpe?g|PO-\d|INV[-/]\d/i);
      expect(m.length).toBeLessThan(120);
    }
    expect(all).toContain('2 invoices are ready; one needs your decision.');
  });

  it('announces through two live regions that are always on the page', () => {
    const empty = renderToStaticMarkup(createElement(Toaster));
    expect(empty).toContain('role="status"');
    expect(empty).toContain('aria-live="polite"');
    expect(empty).toContain('role="alert"');
    expect(empty).toContain('aria-live="assertive"');
    notify.answered();
    notify.offline();
    const html = renderToStaticMarkup(createElement(Toaster));
    const polite = html.slice(html.indexOf('role="status"'), html.indexOf('role="alert"'));
    const urgent = html.slice(html.indexOf('role="alert"'));
    expect(polite).toContain('Decision recorded.');
    expect(urgent).toContain('Veyra cannot be reached.');
    expect(html).toContain('aria-label="Dismiss notification"');
  });
});

describe('background completion', () => {
  const inbox = (statuses: Record<string, ApiInvoiceSummary['status']>): ApiInbox =>
    ({
      counts: {} as ApiInbox['counts'],
      invoices: Object.entries(statuses).map(
        ([id, status]) => ({ id, status }) as ApiInvoiceSummary,
      ),
    }) as ApiInbox;

  it('counts only invoices that were processing and have settled', () => {
    const before = inbox({ a: 'processing', b: 'processing', c: 'processing', d: 'attention' });
    const after = inbox({
      a: 'ready',
      b: 'attention',
      c: 'processing',
      d: 'attention',
      e: 'processing',
    });
    expect(settledSince(before, after)).toEqual({ ready: 1, attention: 1 });
    expect(settledSince(null, after)).toEqual({ ready: 0, attention: 0 });
  });
});
