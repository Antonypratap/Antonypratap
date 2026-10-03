/**
 * The hero's story, as a pure function of a step counter: one supplier bill is checked line by
 * line, Veyrafy finds that less arrived than was billed, stops and asks, and the person rejects the
 * bill before anything is paid. It mirrors the product's quantity check (goods received vs
 * invoiced) and its reject option. All data is illustrative.
 *
 *   steps 0–5   rows 1–6 are worked on, one per step
 *   steps 6–8   the short delivery is found and the question is shown (held for three steps)
 *   step 9      settled: the person rejected the bill; nothing was recorded or paid
 */
export type RowStatus = 'waiting' | 'working' | 'done' | 'ask' | 'decided';

export interface StoryRow {
  id: string;
  label: string;
  detail: string;
}

export const STORY_ROWS: readonly StoryRow[] = [
  { id: 'received', label: 'Bill received', detail: 'Phone photo · MMH/26-27/0412' },
  { id: 'read', label: 'Bill read', detail: 'Supplier, GSTIN, items, tax and totals' },
  { id: 'supplier', label: 'Supplier matched', detail: 'Malabar Malt House · GSTIN valid' },
  { id: 'rate', label: 'Rate as agreed', detail: '₹62.00 per kg · PO-2026-0218' },
  { id: 'tax', label: 'GST and totals', detail: '5% GST · adds up to the paisa' },
  { id: 'delivery', label: 'Billed vs delivered', detail: 'Billed 500 kg · 480 kg received' },
];

/** The detail shown for the delivery row once the person has decided. */
export const DELIVERY_DECIDED = 'Rejected by you · 20 kg short';

const ASK = STORY_ROWS.findIndex((r) => r.id === 'delivery');
const QUESTION_FROM = ASK + 1;
const QUESTION_STEPS = 3;

/** The last step; the story ends there and stays. */
export const STORY_STEPS = QUESTION_FROM + QUESTION_STEPS;

export interface StoryState {
  rows: { row: StoryRow; status: RowStatus; detail: string }[];
  /** Rows finished so far (for the "checking" line). */
  checked: number;
  question: boolean;
  decided: boolean;
}

export function storyAt(step: number): StoryState {
  const s = Math.max(0, Math.min(step, STORY_STEPS));
  const decided = s >= STORY_STEPS;
  const asking = s >= QUESTION_FROM && !decided;
  const rows = STORY_ROWS.map((row, i) => {
    let status: RowStatus;
    if (i === ASK && decided) status = 'decided';
    else if (i === ASK && asking) status = 'ask';
    else status = i < s ? 'done' : i === s ? 'working' : 'waiting';
    const detail = status === 'decided' ? DELIVERY_DECIDED : row.detail;
    return { row, status, detail };
  });
  return { rows, checked: Math.min(s, ASK), question: asking, decided };
}
