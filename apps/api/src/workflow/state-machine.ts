import type { InvoiceState } from '@veyra/shared';

/**
 * The agreed state machine (ARCHITECTURE §5). No other state exists: there is no payment state,
 * no "awaiting confirmation" and no follow-up state. NEEDS_INPUT waits indefinitely.
 */
export const TRANSITIONS: Readonly<Record<InvoiceState, readonly InvoiceState[]>> = {
  UPLOADED: ['EXTRACTING', 'FAILED'],
  EXTRACTING: ['MATCHING', 'FAILED'],
  MATCHING: ['RESOLVING', 'FAILED'],
  RESOLVING: ['VALIDATING', 'FAILED'],
  VALIDATING: ['NEEDS_INPUT', 'COMMITTING', 'FAILED'],
  NEEDS_INPUT: ['MATCHING', 'REJECTED'],
  // Back to MATCHING when the ERP changed under us (pre-commit re-check or a natural-key conflict).
  COMMITTING: ['VERIFIED_PENDING_PAYMENT', 'MATCHING', 'FAILED'],
  VERIFIED_PENDING_PAYMENT: [],
  REJECTED: [],
  // Reprocess re-extracts (or re-runs from MATCHING when extraction had succeeded); or reject.
  FAILED: ['EXTRACTING', 'MATCHING', 'REJECTED'],
};

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`${from} → ${to} is not a legal transition`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: InvoiceState, to: InvoiceState): void {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to);
}

/** States in which Veyra is still working. */
export const PROCESSING_STATES: readonly InvoiceState[] = [
  'UPLOADED',
  'EXTRACTING',
  'MATCHING',
  'RESOLVING',
  'VALIDATING',
  'COMMITTING',
];
