/**
 * The hero animation's script: one purchase that matches, then one that does not and is put
 * right. Each step lights one stage, may send a document along a connector, and has a caption.
 * Sample businesses and figures (illustrative). Veyrafy checks and flags; people approve and
 * release payment. Veyrafy never pays.
 */
export type Stage = 'procurement' | 'supplier' | 'warehouse' | 'veyrafy' | 'match' | 'difference';
export const STAGES: readonly Stage[] = [
  'procurement',
  'supplier',
  'warehouse',
  'veyrafy',
  'match',
  'difference',
];

/** The steps of a difference being put right, shown inside the Difference card. */
export const CORRECTION = ['Reported', 'Supplier corrects', 'Re-checked', 'Approved', 'Paid'];

export interface Step {
  stage: Stage;
  caption: string;
  /** A document travelling down from this stage to the next one. */
  sends?: string[];
  /** Which path this purchase takes. */
  path: 'match' | 'difference';
  /** In the Difference card: how far the correction has got (index into CORRECTION). */
  correction?: number;
  /** In the Match card: approved (0) or paid (1). */
  approval?: 0 | 1;
  /** A highlighted stage revisited during the correction (the supplier sends a new invoice). */
  revisit?: boolean;
}

export const SCRIPT: readonly Step[] = [
  // A purchase that matches.
  {
    path: 'match',
    stage: 'procurement',
    sends: ['PO'],
    caption: 'Procurement raises a purchase order: 500 kg malt at ₹62/kg.',
  },
  {
    path: 'match',
    stage: 'supplier',
    sends: ['Invoice', 'Challan'],
    caption: 'The supplier delivers 500 kg with the invoice and delivery challan.',
  },
  {
    path: 'match',
    stage: 'warehouse',
    sends: ['GRN'],
    caption: 'The warehouse scans the documents and confirms 500 kg received.',
  },
  {
    path: 'match',
    stage: 'veyrafy',
    caption: 'Veyrafy checks the invoice against the PO and GRN in your books.',
  },
  {
    path: 'match',
    stage: 'match',
    approval: 0,
    caption: 'Everything matches. The manager approves.',
  },
  { path: 'match', stage: 'match', approval: 1, caption: 'Your team releases the payment.' },
  // A purchase that does not match, put right before payment.
  {
    path: 'difference',
    stage: 'procurement',
    sends: ['PO'],
    caption: 'Procurement orders 20 kg of prawns at ₹700/kg.',
  },
  {
    path: 'difference',
    stage: 'supplier',
    sends: ['Invoice', 'Challan'],
    caption: 'The supplier delivers with an invoice for 20 kg.',
  },
  {
    path: 'difference',
    stage: 'warehouse',
    sends: ['GRN'],
    caption: 'The warehouse confirms 18 kg received.',
  },
  {
    path: 'difference',
    stage: 'veyrafy',
    caption: 'Veyrafy checks: 20 kg billed, 18 kg received.',
  },
  {
    path: 'difference',
    stage: 'difference',
    correction: 0,
    caption: 'Payment is held. The ₹1,400 difference is reported with the evidence.',
  },
  {
    path: 'difference',
    stage: 'supplier',
    revisit: true,
    correction: 1,
    sends: ['Invoice'],
    caption: 'The supplier sends a corrected invoice for 18 kg.',
  },
  {
    path: 'difference',
    stage: 'veyrafy',
    correction: 2,
    caption: 'Veyrafy checks again. It matches now.',
  },
  {
    path: 'difference',
    stage: 'difference',
    correction: 4,
    caption: 'The manager approves, and your team releases the payment.',
  },
];
