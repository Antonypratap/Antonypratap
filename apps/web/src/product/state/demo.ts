/**
 * Local demo state for the product prototype: decisions made in this browser session.
 * Pure functions; the React store wraps them. It is the single source for every count,
 * status and history in the product. Nothing is sent anywhere.
 */
import { INVOICES, WEEK, type DemoInvoice, type Outcome } from '../data/invoices';

export interface Decision {
  optionId: string;
  label: string;
  outcome: Outcome;
  result: string;
  /** Order in which decisions were made (for "most recent" lists). */
  seq: number;
}

export interface DemoState {
  decisions: Readonly<Record<string, Decision>>;
  seq: number;
}

export type DemoAction =
  | { type: 'decide'; invoiceId: string; optionId: string }
  | { type: 'undo'; invoiceId: string }
  | { type: 'reset' };

export const INITIAL_STATE: DemoState = { decisions: {}, seq: 0 };

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'decide': {
      if (state.decisions[action.invoiceId]) return state;
      const option = INVOICES.find((i) => i.id === action.invoiceId)?.question?.options.find(
        (o) => o.id === action.optionId,
      );
      if (!option) return state;
      const seq = state.seq + 1;
      return {
        seq,
        decisions: {
          ...state.decisions,
          [action.invoiceId]: {
            optionId: option.id,
            label: option.label,
            outcome: option.outcome,
            result: option.result,
            seq,
          },
        },
      };
    }
    case 'undo': {
      if (!state.decisions[action.invoiceId]) return state;
      const rest = Object.fromEntries(
        Object.entries(state.decisions).filter(([id]) => id !== action.invoiceId),
      );
      return { ...state, decisions: rest };
    }
    case 'reset':
      return INITIAL_STATE;
  }
}

/** What a person sees as the invoice's status. Business language only. */
export type InvoiceStatus = 'attention' | 'handled' | 'ready' | 'processing' | 'rejected';

export const STATUS_LABEL: Record<InvoiceStatus, string> = {
  attention: 'Needs your attention',
  handled: 'Handled',
  ready: 'Ready',
  processing: 'Processing',
  rejected: 'Rejected',
};

/** How each status is drawn, the same on every screen. */
export const STATUS_TONE: Record<InvoiceStatus, 'attention' | 'handled' | 'received' | 'neutral'> =
  {
    attention: 'attention',
    handled: 'handled',
    ready: 'handled',
    processing: 'received',
    rejected: 'neutral',
  };

export function statusOf(invoice: DemoInvoice, state: DemoState): InvoiceStatus {
  if (invoice.initialStatus === 'handled') return 'handled';
  const decision = state.decisions[invoice.id];
  return decision ? decision.outcome : 'attention';
}

export function openQuestions(state: DemoState): DemoInvoice[] {
  return INVOICES.filter((i) => statusOf(i, state) === 'attention');
}

export function answeredQuestions(
  state: DemoState,
): { invoice: DemoInvoice; decision: Decision }[] {
  return INVOICES.flatMap((invoice) => {
    const decision = state.decisions[invoice.id];
    return decision ? [{ invoice, decision }] : [];
  }).sort((a, b) => b.decision.seq - a.decision.seq);
}

/**
 * The week at a glance, derived from the same state as every other count.
 * Invariant: received = handled + needsYou + ready + processing + rejected.
 *  - handled: Veyra finished these on its own.
 *  - needsYou: open questions (the attention queue).
 *  - ready / processing / rejected: invoices you decided, by what happened next.
 */
export interface WeekSummary {
  received: number;
  handled: number;
  needsYou: number;
  decidedByYou: number;
  ready: number;
  processing: number;
  rejected: number;
}

export function weekSummary(state: DemoState): WeekSummary {
  const decided = Object.values(state.decisions);
  const count = (outcome: Outcome) => decided.filter((d) => d.outcome === outcome).length;
  const needsYou = openQuestions(state).length;
  return {
    received: WEEK.received,
    handled: WEEK.handled,
    needsYou,
    decidedByYou: decided.length,
    ready: count('ready'),
    processing: count('processing'),
    rejected: count('rejected'),
  };
}

/** The next question after `currentId` in queue order, wrapping around; null when none are left. */
export function nextQuestion(state: DemoState, currentId: string): DemoInvoice | null {
  const open = openQuestions(state).filter((i) => i.id !== currentId);
  if (open.length === 0) return null;
  const order = INVOICES.map((i) => i.id);
  const at = order.indexOf(currentId);
  return open.find((i) => order.indexOf(i.id) > at) ?? open[0] ?? null;
}

/** Decisions in the order they were made, for keeping the demo across a page reload. */
export function decisionLog(state: DemoState): { invoiceId: string; optionId: string }[] {
  return answeredQuestions(state)
    .reverse()
    .map(({ invoice, decision }) => ({ invoiceId: invoice.id, optionId: decision.optionId }));
}

/** Rebuild state from a saved log. Anything that no longer matches the demo is ignored. */
export function replayDecisions(log: unknown): DemoState {
  if (!Array.isArray(log)) return INITIAL_STATE;
  return log.reduce<DemoState>((state, entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return state;
    const { invoiceId, optionId } = entry as Record<string, unknown>;
    if (typeof invoiceId !== 'string' || typeof optionId !== 'string') return state;
    return demoReducer(state, { type: 'decide', invoiceId, optionId });
  }, INITIAL_STATE);
}
