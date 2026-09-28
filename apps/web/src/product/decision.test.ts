import { describe, expect, it } from 'vitest';
import { QUESTION_KINDS, type ApiInvoiceDetail } from '@veyra/shared';
import { AFTER_DECISION, ASK_LABEL, completionEvidence, erpStatusText } from './state/decision';

type Check = ApiInvoiceDetail['checks'][number];
const check = (rule: string, outcome: Check['outcome'], naReason: string | null = null): Check =>
  ({ rule, name: rule, lineNo: null, outcome, naReason, message: '' }) as Check;

const invoice = (over: Partial<ApiInvoiceDetail> = {}): ApiInvoiceDetail =>
  ({
    status: 'handled',
    checks: ['R06', 'R07', 'R09', 'R20', 'R21', 'R22', 'R23', 'R25', 'R26']
      .map((r) => check(r, 'pass'))
      .concat(check('R10', 'not_applicable', 'NO_ROUND_OFF_LINE')),
    erp: {
      vendor: 'Shakti Steel Suppliers Pvt Ltd (V001)',
      poNumber: 'PO-2026-0110',
      purchaseInvoiceId: 'PINV/2026-27/1',
      records: [],
      reconciling: false,
      receipts: [{ number: 'GRN-2026-0209', date: '2026-09-10', byYou: false }],
      purchaseInvoice: {
        id: 'PINV/2026-27/1',
        status: 'verified_pending_payment',
        totalPaise: 737_500,
        lines: 1,
      },
    },
    ...over,
  }) as ApiInvoiceDetail;

describe('decision presentation', () => {
  it('every question kind has a plain label and a next step; no codes', () => {
    for (const kind of QUESTION_KINDS) {
      expect(ASK_LABEL[kind]).toMatch(/^[A-Z][a-z]/);
      expect(`${ASK_LABEL[kind]} ${AFTER_DECISION[kind]}`).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
    expect(AFTER_DECISION.VALIDATION_FAILURE).toMatch(/no override/);
  });

  it('"Invoice ready" evidence comes from the checks and ERP records', () => {
    expect(completionEvidence(invoice())).toEqual([
      { label: 'Supplier', value: 'Shakti Steel Suppliers Pvt Ltd (V001)' },
      { label: 'Purchase order', value: 'PO-2026-0110' },
      { label: 'Goods receipt', value: 'GRN-2026-0209' },
      { label: '3-way match', value: 'Order, receipt and invoice agree' },
      { label: 'Amounts', value: 'Prices, tax and totals add up' },
      { label: 'ERP record', value: 'Purchase invoice PINV/2026-27/1 · 1 line · ₹7,375.00' },
    ]);
  });

  it('claims nothing it has no evidence for', () => {
    const bare = invoice({
      checks: [check('R21', 'fail')],
      erp: {
        vendor: null,
        poNumber: null,
        purchaseInvoiceId: null,
        records: [],
        reconciling: false,
        receipts: [],
        purchaseInvoice: null,
      },
    });
    expect(completionEvidence(bare)).toEqual([]);
  });

  it('marks receipts you confirmed and orders created from the invoice', () => {
    const rows = completionEvidence(
      invoice({
        checks: [
          check('R21', 'not_applicable', 'PO_DERIVED_FROM_INVOICE'),
          check('R25', 'pass'),
          check('R26', 'pass'),
        ],
        erp: {
          ...invoice().erp,
          receipts: [{ number: 'GRN/2026-27/1', date: '2026-09-17', byYou: true }],
        },
      }),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { label: 'Purchase order', value: 'PO-2026-0110, created from this invoice' },
        { label: 'Goods receipt', value: 'GRN/2026-27/1 (confirmed by you)' },
        { label: '3-way match', value: 'Receipt agrees; order comparisons do not apply' },
      ]),
    );
  });

  it('the only ERP status reads as verified, pending payment', () => {
    expect(erpStatusText('verified_pending_payment')).toBe('Verified, pending payment');
  });
});
