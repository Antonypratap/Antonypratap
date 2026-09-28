import { describe, expect, it } from 'vitest';
import { INVOICES, WEEK, invoiceById } from './data/invoices';
import { PURCHASE_ORDERS, VENDORS, ITEMS } from './data/erp';
import {
  INITIAL_STATE,
  answeredQuestions,
  decisionLog,
  demoReducer,
  nextQuestion,
  openQuestions,
  replayDecisions,
  statusOf,
  weekSummary,
  type DemoState,
} from './state/demo';
import { formatDate, greetingFor } from './format';
import { hrefFor, parseHash } from './router';

describe('demo fixtures match docs/DEMO.md', () => {
  it('has the seeded ERP records', () => {
    expect(VENDORS).toHaveLength(7);
    expect(ITEMS).toHaveLength(7);
    expect(PURCHASE_ORDERS).toHaveLength(13);
    expect(PURCHASE_ORDERS.filter((p) => p.grn === null).map((p) => p.number)).toEqual([
      'PO-2026-0104',
    ]);
  });

  it('computes invoice totals exactly as DEMO.md states them', () => {
    const total = (id: string) => invoiceById(id)?.totalPaise;
    expect(total('s01')).toBe(11_387_000);
    expect(total('s02')).toBe(1_711_000);
    expect(total('s04')).toBe(3_469_200);
    expect(total('s09')).toBe(802_518);
    expect(total('s10')).toBe(1_475_000);
    expect(total('s12')).toBe(737_600); // as printed, ₹1.00 over
    expect(total('s14')).toBe(1_604_800);
    expect(total('s17')).toBe(2_891_000);
    expect(invoiceById('s02')?.igstPaise).toBe(261_000);
  });

  it('has 11 invoices needing attention, each with exactly one question and a way to say no', () => {
    const attention = INVOICES.filter((i) => i.initialStatus === 'attention');
    expect(attention).toHaveLength(WEEK.needsAttention);
    expect(WEEK.needsAttention).toBe(11);
    for (const i of attention) {
      expect(i.question?.options.length).toBeGreaterThan(0);
      expect(i.question?.options.filter((o) => o.emphasis === 'primary')).toHaveLength(1);
    }
    expect(INVOICES.filter((i) => i.initialStatus === 'handled').every((i) => !i.question)).toBe(
      true,
    );
  });

  it('never shows internal vocabulary to the user', () => {
    const text = JSON.stringify(INVOICES.map((i) => i.question ?? null));
    for (const banned of [
      'confidence',
      'R21',
      'VF_',
      'NEEDS_INPUT',
      'GRN',
      'extraction',
      'AI ',
      'model',
    ]) {
      expect(text).not.toContain(banned);
    }
  });
});

const decide = (s: DemoState, invoiceId: string, optionId: string): DemoState =>
  demoReducer(s, { type: 'decide', invoiceId, optionId });

const status = (s: DemoState, id: string) => {
  const inv = invoiceById(id);
  if (!inv) throw new Error(`fixture ${id}`);
  return statusOf(inv, s);
};

/** received = handled + needsYou + ready + processing + rejected, and every count agrees. */
function expectConsistent(s: DemoState): void {
  const w = weekSummary(s);
  expect(w.handled + w.needsYou + w.ready + w.processing + w.rejected).toBe(w.received);
  expect(w.ready + w.processing + w.rejected).toBe(w.decidedByYou);
  expect(w.needsYou).toBe(openQuestions(s).length);
  expect(w.needsYou).toBe(INVOICES.filter((i) => statusOf(i, s) === 'attention').length);
  expect(w.decidedByYou).toBe(answeredQuestions(s).length);
  expect(w.needsYou + w.decidedByYou).toBe(WEEK.needsAttention);
}

describe('demo decisions', () => {
  it('starts with the week as shipped: 142 = 131 + 11', () => {
    expect(weekSummary(INITIAL_STATE)).toEqual({
      received: 142,
      handled: 131,
      needsYou: 11,
      decidedByYou: 0,
      ready: 0,
      processing: 0,
      rejected: 0,
    });
    expect(WEEK.handled + WEEK.needsAttention).toBe(WEEK.received);
    expectConsistent(INITIAL_STATE);
  });

  it('a decision leaves the queue, enters history and makes the invoice ready', () => {
    const s = decide(INITIAL_STATE, 's10', 'accept');
    expect(status(s, 's10')).toBe('ready');
    expect(weekSummary(s)).toMatchObject({ handled: 131, needsYou: 10, decidedByYou: 1, ready: 1 });
    expect(openQuestions(s).map((i) => i.id)).not.toContain('s10');
    expect(answeredQuestions(s).map((a) => a.invoice.id)).toEqual(['s10']);
    expectConsistent(s);
  });

  it('asking someone for something keeps the invoice processing, never rejected', () => {
    for (const [id, optionId] of [
      ['s10', 'ask'],
      ['s14', 'ask'],
      ['s09', 'ask'],
      ['s08', 'ask'],
      ['s12', 'ask'],
      ['s15', 'ask'],
    ] as const) {
      const s = decide(INITIAL_STATE, id, optionId);
      expect(status(s, id)).toBe('processing');
      expectConsistent(s);
    }
  });

  it('only an explicit rejection makes an invoice rejected', () => {
    for (const inv of INVOICES) {
      for (const o of inv.question?.options ?? []) {
        expect(o.outcome === 'rejected').toBe(/^Reject/.test(o.label));
      }
    }
    const s = decide(INITIAL_STATE, 's16', 'reject');
    expect(status(s, 's16')).toBe('rejected');
    expect(weekSummary(s)).toMatchObject({ needsYou: 10, rejected: 1, ready: 0 });
    expectConsistent(s);
  });

  it('keeps every count consistent through a whole run of decisions and undos', () => {
    let s = INITIAL_STATE;
    for (const inv of openQuestions(INITIAL_STATE)) {
      const first = inv.question?.options[0];
      if (first) s = decide(s, inv.id, first.id);
      expectConsistent(s);
    }
    s = demoReducer(s, { type: 'undo', invoiceId: 's17' });
    expectConsistent(s);
    expect(openQuestions(s).map((i) => i.id)).toEqual(['s17']);
  });

  it('survives a reload: the decision log replays to the same state', () => {
    const s = decide(decide(INITIAL_STATE, 's10', 'accept'), 's16', 'reject');
    const replayed = replayDecisions(JSON.parse(JSON.stringify(decisionLog(s))));
    expect(replayed).toEqual(s);
    expect(replayDecisions('garbage')).toEqual(INITIAL_STATE);
    expect(replayDecisions([{ invoiceId: 's01', optionId: 'accept' }, null])).toEqual(
      INITIAL_STATE,
    );
  });

  it('ignores unknown options, repeated decisions and handled invoices', () => {
    const s = demoReducer(INITIAL_STATE, { type: 'decide', invoiceId: 's10', optionId: 'accept' });
    expect(demoReducer(s, { type: 'decide', invoiceId: 's10', optionId: 'reject' })).toBe(s);
    expect(demoReducer(INITIAL_STATE, { type: 'decide', invoiceId: 's10', optionId: 'nope' })).toBe(
      INITIAL_STATE,
    );
    expect(
      demoReducer(INITIAL_STATE, { type: 'decide', invoiceId: 's01', optionId: 'accept' }),
    ).toBe(INITIAL_STATE);
  });

  it('undo and reset restore the open question', () => {
    const s = demoReducer(INITIAL_STATE, { type: 'decide', invoiceId: 's10', optionId: 'accept' });
    expect(
      openQuestions(demoReducer(s, { type: 'undo', invoiceId: 's10' })).map((i) => i.id),
    ).toContain('s10');
    expect(demoReducer(s, { type: 'reset' })).toEqual(INITIAL_STATE);
  });

  it('finds the next open question, wrapping around, and null when done', () => {
    expect(nextQuestion(INITIAL_STATE, 's10')?.id).toBe('s14');
    expect(nextQuestion(INITIAL_STATE, 's11b')?.id).toBe('s10');
    let s = INITIAL_STATE;
    for (const i of openQuestions(INITIAL_STATE)) {
      const first = i.question?.options[0];
      if (first) s = demoReducer(s, { type: 'decide', invoiceId: i.id, optionId: first.id });
    }
    expect(nextQuestion(s, 's10')).toBeNull();
    expect(weekSummary(s).needsYou).toBe(0);
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

describe('audit trail', () => {
  it('tells an attention invoice’s story, and adds the decision once made', async () => {
    const { auditTrail } = await import('./state/audit');
    const inv = invoiceById('s10');
    if (!inv) throw new Error('fixture');
    const before = auditTrail(inv, undefined);
    expect(before.map((e) => e.title)).toEqual([
      'Invoice received',
      'Invoice read',
      'Supplier identified',
      'Purchase information checked',
      'Issue found',
      'Question sent to you',
      'Waiting for your decision',
    ]);
    expect(before.at(-1)).toMatchObject({ title: 'Waiting for your decision', by: 'You' });
    const s = decide(INITIAL_STATE, 's10', 'accept');
    const after = auditTrail(inv, s.decisions['s10']);
    expect(after.slice(-2)).toMatchObject([
      { title: 'You decided', by: 'You' },
      { title: 'Ready for payment', by: 'Veyra', tone: 'handled' },
    ]);
    const asked = auditTrail(inv, decide(INITIAL_STATE, 's10', 'ask').decisions['s10']);
    expect(asked.at(-1)).toMatchObject({ title: 'Following up', by: 'Veyra' });
  });

  it('a handled invoice ends ready for payment, never paid', async () => {
    const { auditTrail } = await import('./state/audit');
    const inv = invoiceById('s01');
    if (!inv) throw new Error('fixture');
    const trail = auditTrail(inv, undefined);
    expect(trail.at(-1)?.title).toBe('Ready for payment');
    expect(JSON.stringify(trail)).not.toMatch(/\bpaid\b/i);
  });
});
