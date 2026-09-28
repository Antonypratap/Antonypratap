/** A plain-language account of what happened to an invoice. Illustrative: built from the fixtures. */
import type { DemoInvoice } from '../data/invoices';
import type { Decision } from './demo';

export interface AuditEntry {
  title: string;
  detail: string;
  tone: 'neutral' | 'handled' | 'attention';
  by: 'Veyra' | 'You';
}

export function auditTrail(invoice: DemoInvoice, decision: Decision | undefined): AuditEntry[] {
  const q = invoice.question;
  const entries: AuditEntry[] = [
    {
      title: 'Invoice received',
      detail: `${invoice.source === 'Photo' ? 'Phone photo' : 'PDF'}, ${invoice.receivedLabel}`,
      tone: 'neutral',
      by: 'Veyra',
    },
    {
      title: 'Invoice read',
      detail: `${invoice.lines.length === 1 ? '1 line' : `${invoice.lines.length} lines`}, totals and tax`,
      tone: 'neutral',
      by: 'Veyra',
    },
    invoice.supplier.gstin && q?.summary !== 'Which supplier?' && q?.summary !== 'GSTIN not valid'
      ? {
          title: 'Supplier identified',
          detail: invoice.supplier.name,
          tone: 'neutral',
          by: 'Veyra',
        }
      : {
          title: 'Supplier checked',
          detail: q?.evidence ?? 'Confirmed',
          tone: 'neutral',
          by: 'Veyra',
        },
    {
      title: 'Purchase information checked',
      detail: invoice.poNumber
        ? `Order ${invoice.poNumber} and its receipts`
        : 'No order on the invoice',
      tone: 'neutral',
      by: 'Veyra',
    },
  ];
  if (!q) {
    entries.push({
      title: 'Everything matched',
      detail: invoice.handledNote ?? 'No questions',
      tone: 'handled',
      by: 'Veyra',
    });
    entries.push({
      title: 'Ready for payment',
      detail: 'Recorded in the ERP. Paying stays with your team.',
      tone: 'handled',
      by: 'Veyra',
    });
    return entries;
  }
  entries.push({
    title: 'Issue found',
    detail: `${q.summary}: ${q.evidence}`,
    tone: 'attention',
    by: 'Veyra',
  });
  entries.push({
    title: 'Question sent to you',
    detail: q.headline,
    tone: 'attention',
    by: 'Veyra',
  });
  if (!decision) {
    entries.push({
      title: 'Waiting for your decision',
      detail: 'Nothing moves until you decide.',
      tone: 'attention',
      by: 'You',
    });
    return entries;
  }
  entries.push({
    title: decision.outcome === 'rejected' ? 'You rejected the invoice' : 'You decided',
    detail: decision.outcome === 'rejected' ? decision.label : `“${decision.label}”`,
    tone: 'neutral',
    by: 'You',
  });
  entries.push(afterDecision(decision));
  return entries;
}

/** What Veyra did with your decision. */
function afterDecision(decision: Decision): AuditEntry {
  switch (decision.outcome) {
    case 'ready':
      return {
        title: 'Ready for payment',
        detail: `${decision.result} Recorded in the ERP. Paying stays with your team.`,
        tone: 'handled',
        by: 'Veyra',
      };
    case 'processing':
      return {
        title: 'Following up',
        detail: `${decision.result} Veyra will check the invoice again when the answer arrives.`,
        tone: 'neutral',
        by: 'Veyra',
      };
    case 'rejected':
      return {
        title: 'Closed',
        detail: `${decision.result} Nothing was recorded in the ERP.`,
        tone: 'neutral',
        by: 'Veyra',
      };
  }
}
