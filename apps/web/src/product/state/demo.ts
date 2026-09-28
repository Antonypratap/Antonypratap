/**
 * Local demo state for the product prototype: decisions made in this browser session.
 * Pure functions; the React store wraps them. Nothing is persisted or sent anywhere.
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

/** The week at a glance. received = needsYou + handled + rejected, always. */
export function weekSummary(state: DemoState): {
  received: number;
  handled: number;
  needsYou: number;
  rejected: number;
} {
  const decided = Object.values(state.decisions);
  const rejected = decided.filter((d) => d.outcome === 'rejected').length;
  const resolved = decided.length - rejected;
  return {
    received: WEEK.received,
    handled: WEEK.handled + resolved,
    needsYou: WEEK.needsAttention - decided.length,
    rejected,
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
