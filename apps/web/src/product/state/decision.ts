import type { ApiInvoiceDetail, ApiQuestion } from '@veyra/shared';
import { inr } from '../format';

/**
 * How a question and a finished invoice are presented (Phase 3E). Pure functions over what the
 * server says: nothing here decides, simulates or infers a state. Question codes never appear.
 */

type Kind = ApiQuestion['kind'];

/** The line above a question: what kind of help Veyra needs. */
export const ASK_LABEL: Record<Kind, string> = {
  MISSING_DATA: 'Veyra needs you to confirm',
  AMBIGUOUS_MATCH: 'Your decision is needed',
  BUSINESS_DECISION: 'Your decision is needed',
  CREATION_APPROVAL: 'Your approval is needed',
  VALIDATION_FAILURE: 'Check needed',
};

/** What happens after the decision, in one sentence. */
export const AFTER_DECISION: Record<Kind, string> = {
  MISSING_DATA:
    'Veyra then checks the whole invoice again. It is recorded only if every check passes.',
  AMBIGUOUS_MATCH:
    'Veyra then checks the invoice against the one you choose. Nothing is linked by name alone.',
  BUSINESS_DECISION: 'Veyra then checks the invoice again with your decision.',
  CREATION_APPROVAL:
    'Veyra then checks the invoice again. What you approve is written to your ERP only with the invoice.',
  VALIDATION_FAILURE:
    'There is no override: correct what was misread, fix the record and check again, or reject.',
};

export interface EvidenceRow {
  label: string;
  value: string;
}

const passed = (invoice: ApiInvoiceDetail, rules: readonly string[]) =>
  invoice.checks.filter((c) => rules.includes(c.rule));

/**
 * The evidence behind "Invoice ready", taken only from the invoice's own checks and ERP records.
 * Rows without evidence are left out rather than asserted.
 */
export function completionEvidence(invoice: ApiInvoiceDetail): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  const { erp } = invoice;
  if (erp.vendor) rows.push({ label: 'Supplier', value: erp.vendor });
  const derived = invoice.checks.some((c) => c.naReason === 'PO_DERIVED_FROM_INVOICE');
  if (erp.poNumber)
    rows.push({
      label: 'Purchase order',
      value: derived ? `${erp.poNumber}, created from this invoice` : erp.poNumber,
    });
  if (erp.receipts.length)
    rows.push({
      label: erp.receipts.length === 1 ? 'Goods receipt' : 'Goods receipts',
      value: erp.receipts
        .map((r) => (r.byYou ? `${r.number} (confirmed by you)` : r.number))
        .join(', '),
    });
  const match = passed(invoice, ['R20', 'R21', 'R22', 'R23', 'R25', 'R26']);
  if (match.length && match.every((c) => c.outcome === 'pass'))
    rows.push({ label: '3-way match', value: 'Order, receipt and invoice agree' });
  else if (derived && passed(invoice, ['R25', 'R26']).every((c) => c.outcome === 'pass'))
    rows.push({ label: '3-way match', value: 'Receipt agrees; order comparisons do not apply' });
  const sums = passed(invoice, ['R06', 'R07', 'R09', 'R10']);
  if (sums.length && sums.every((c) => c.outcome === 'pass' || c.outcome === 'not_applicable'))
    rows.push({ label: 'Amounts', value: 'Prices, tax and totals add up' });
  const recorded = erp.purchaseInvoice;
  if (recorded)
    rows.push({
      label: 'ERP record',
      value: `Purchase invoice ${recorded.id} · ${recorded.lines} ${recorded.lines === 1 ? 'line' : 'lines'} · ${inr(recorded.totalPaise)}`,
    });
  return rows;
}

/** The recorded ERP status in words. V1 knows one: verified, payment still with the team. */
export function erpStatusText(status: string): string {
  return status === 'verified_pending_payment' ? 'Verified, pending payment' : status;
}
