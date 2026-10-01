/**
 * The hero's story, as a pure function of a step counter: one invoice is checked line by line,
 * Veyrafy stops at the one thing only a person can confirm (did the goods arrive?), the person
 * answers, and the invoice is recorded in the ERP. It mirrors the product's "Missing goods receipt"
 * scenario (docs/DEMO.md §8). All data is illustrative.
 *
 *   steps 0–4   rows 1–5 are worked on, one per step
 *   steps 5–7   the question is shown (held for three steps)
 *   step 8      the person has answered; the ERP record is being written
 *   step 9      settled: the invoice is ready
 */
export type RowStatus = 'waiting' | 'working' | 'done' | 'ask' | 'decided';

export interface StoryRow {
  id: string;
  label: string;
  detail: string;
}

export const STORY_ROWS: readonly StoryRow[] = [
  { id: 'received', label: 'Invoice received', detail: 'APX/26-27/1187 · PDF' },
  { id: 'read', label: 'Invoice read', detail: 'Supplier, GSTIN, items, HSN, tax and totals' },
  { id: 'supplier', label: 'Supplier matched', detail: 'Apex Components · GSTIN valid' },
  { id: 'order', label: 'Order matched', detail: 'PO-2026-0104 · 50 at ₹145.00 · IGST 18%' },
  { id: 'receipt', label: 'Goods receipt', detail: 'No receipt recorded for this order' },
  { id: 'erp', label: 'Recorded in your ERP', detail: 'Purchase invoice · pending payment' },
];

/** The detail shown for the goods-receipt row once the person has answered. */
export const RECEIPT_CONFIRMED = 'Receipt recorded by you · 50 received';

const RECEIPT = STORY_ROWS.findIndex((r) => r.id === 'receipt');
const ERP = STORY_ROWS.findIndex((r) => r.id === 'erp');
const QUESTION_FROM = RECEIPT + 1;
const QUESTION_STEPS = 3;
const ANSWERED = QUESTION_FROM + QUESTION_STEPS;

/** The last step; the story ends there and stays. */
export const STORY_STEPS = ANSWERED + 1;

export interface StoryState {
  rows: { row: StoryRow; status: RowStatus; detail: string }[];
  question: boolean;
  answered: boolean;
  ready: boolean;
}

export function storyAt(step: number): StoryState {
  const s = Math.max(0, Math.min(step, STORY_STEPS));
  const answered = s >= ANSWERED;
  const asking = s >= QUESTION_FROM && !answered;
  const rows = STORY_ROWS.map((row, i) => {
    let status: RowStatus;
    if (i === RECEIPT && answered) status = 'decided';
    else if (i === RECEIPT && asking) status = 'ask';
    else if (i === ERP) status = s === ANSWERED ? 'working' : s > ANSWERED ? 'done' : 'waiting';
    else status = i < s ? 'done' : i === s ? 'working' : 'waiting';
    const detail = status === 'decided' ? RECEIPT_CONFIRMED : row.detail;
    return { row, status, detail };
  });
  return { rows, question: asking, answered, ready: s === STORY_STEPS };
}
