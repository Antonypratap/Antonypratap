import type { ErpCapability } from '@veyra/erp-connector';
import type { OptionDraft, QuestionDraft } from '../engine/types';

/**
 * When the ERP is read-only for Veyrafy (a connection to the business's own ERP over its API, in
 * this phase), Veyrafy cannot add a supplier, item, order or goods receipt, nor reactivate a
 * supplier. A question that would offer to do that offers instead to record it in the ERP and
 * check again (after the next sync), or to reject. Nothing missing is ever treated as found.
 */

const CREATE_CAPABILITY: Record<string, ErpCapability> = {
  vendor: 'vendor.create',
  vendor_reactivation: 'vendor.reactivate',
  item: 'item.create',
  po: 'purchase_order.create',
  grn: 'goods_receipt.create',
};

const RECHECK_LABEL: Record<string, string> = {
  vendor: 'I added the supplier in our ERP. Check again',
  vendor_reactivation: 'I reactivated the supplier in our ERP. Check again',
  item: 'I added the item in our ERP. Check again',
  po: 'I created the order in our ERP. Check again',
  grn: 'I recorded the receipt in our ERP. Check again',
};

const WHY =
  'Veyrafy reads your ERP and does not change it. Record it in your ERP; Veyrafy checks again with the next sync of its records.';

/** Whether Veyrafy can record purchase invoices in this ERP (otherwise it only reads it). */
export function canRecordInvoices(capabilities: readonly ErpCapability[]): boolean {
  return capabilities.includes('purchase_invoice.create');
}

/** The questions, with every creation the ERP cannot accept replaced as described above. */
export function readOnlyQuestions(
  drafts: QuestionDraft[],
  capabilities: readonly ErpCapability[],
): QuestionDraft[] {
  return drafts.map((d) => {
    let changed = false;
    const options: OptionDraft[] = [];
    for (const o of d.options) {
      const e = o.effect;
      const entity =
        e.type === 'APPROVE_CREATION' || e.type === 'REQUEST_CREATION' ? e.entity : null;
      const needed = entity ? CREATE_CAPABILITY[entity] : undefined;
      if (!entity || !needed || capabilities.includes(needed)) {
        options.push(o);
        continue;
      }
      changed = true;
      if (options.some((x) => x.id === 'recheck')) continue;
      options.push({
        id: 'recheck',
        label: RECHECK_LABEL[entity] ?? 'I fixed it in our ERP. Check again',
        effect: { type: 'RECHECK' },
        emphasis: o.emphasis === 'primary' ? 'primary' : 'secondary',
        result: 'Veyrafy checks the invoice again with your ERP’s latest records.',
        input: null,
      });
    }
    if (!changed) return d;
    return {
      ...d,
      options,
      why: [
        ...d.why.filter(
          (w) => !/added when|recorded\b.*with the invoice|saved to your item list/i.test(w),
        ),
        WHY,
      ],
    };
  });
}
