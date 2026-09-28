/**
 * The hero's staged product preview, as a pure function of a step counter:
 *   steps 1–5   invoices arrive
 *   steps 6–10  each is handled (one needs a person)
 *   step 11     that one reaches the team
 *   step 12     everything else is ready to move forward
 * All data is illustrative.
 */
export type RowStatus = 'received' | 'handled' | 'attention';
export type Stage = 'arrive' | 'handle' | 'people' | 'ready';

export interface HeroInvoice {
  id: string;
  vendor: string;
  number: string;
  amount: string;
  outcome: Exclude<RowStatus, 'received'>;
}

export const HERO_INVOICES: readonly HeroInvoice[] = [
  {
    id: 'a',
    vendor: 'Kestrel Packaging',
    number: 'INV-20417',
    amount: '₹48,260.00',
    outcome: 'handled',
  },
  {
    id: 'b',
    vendor: 'Northline Logistics',
    number: 'NL/8831',
    amount: '₹1,12,400.00',
    outcome: 'handled',
  },
  {
    id: 'c',
    vendor: 'Altura Components',
    number: 'AC-5530',
    amount: '₹36,875.00',
    outcome: 'handled',
  },
  {
    id: 'd',
    vendor: 'Brightwater Supplies',
    number: '#4821',
    amount: '₹2,04,300.00',
    outcome: 'attention',
  },
  {
    id: 'e',
    vendor: 'Sable Office Co.',
    number: 'SO-0917',
    amount: '₹9,640.00',
    outcome: 'handled',
  },
];

const N = HERO_INVOICES.length;
export const HERO_STEPS = 2 * N + 2;

export interface HeroState {
  rows: { invoice: HeroInvoice; visible: boolean; status: RowStatus }[];
  stage: Stage | null;
  counts: { arrived: number; handled: number; people: number; ready: number };
  showCallout: boolean;
  showReady: boolean;
}

export function heroStateAt(step: number): HeroState {
  const s = Math.max(0, Math.min(step, HERO_STEPS));
  const arrived = Math.min(s, N);
  const resolved = Math.max(0, Math.min(s - N, N));
  const rows = HERO_INVOICES.map((invoice, i) => ({
    invoice,
    visible: i < arrived,
    status: (i < resolved ? invoice.outcome : 'received') as RowStatus,
  }));
  const handled = rows.filter((r) => r.status === 'handled').length;
  const needsPeople = rows.filter((r) => r.status === 'attention').length;
  const showCallout = s >= 2 * N + 1;
  const showReady = s >= 2 * N + 2;
  const stage: Stage | null =
    s === 0 ? null : s <= N ? 'arrive' : s <= 2 * N ? 'handle' : showReady ? 'ready' : 'people';
  return {
    rows,
    stage,
    counts: {
      arrived,
      handled,
      people: showCallout ? needsPeople : 0,
      ready: showReady ? handled : 0,
    },
    showCallout,
    showReady,
  };
}
