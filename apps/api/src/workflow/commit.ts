import { and, eq } from 'drizzle-orm';
import {
  normalizeInvoiceNumber,
  purchaseInvoiceIdempotencyKey,
  type ErpId,
  type IdempotencyKey,
  type InvoiceId,
  type IsoDate,
} from '@veyra/shared';
import { financialYearOf } from '@veyra/india-tax';
import { ErpConflictError } from '@veyra/erp-connector';
import * as t from '../db/schema';
import type { JsonValue } from '../engine/fields';
import type { CommitPlan, PoLineRef, Ref } from '../engine/types';
import type { Veyra } from './veyra';

export interface CommitHooks {
  /**
   * Test only: called after the ERP accepted a write and before Veyra records it. Throwing a
   * CrashSignal here simulates the process dying at the worst possible moment.
   */
  afterErpWrite?: (entity: string, erpId: string) => void;
}

/** Test only: stands for the process dying. The job runner does not catch it. */
export class CrashSignal extends Error {
  constructor(where: string) {
    super(`simulated crash: ${where}`);
    this.name = 'CrashSignal';
  }
}

/** Sorted-key JSON, to compare a frozen plan with a fresh one. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

class PlanChanged extends Error {}

/**
 * The payload shapes the engine stages (engine/run.ts). Only the fields of the action's entity are
 * present; the connector validates every write input again with its own schemas.
 */
interface StagedPayload {
  vendorId: string;
  name: string;
  gstin: string;
  address: string;
  hsnSac: string;
  uom: string;
  gstRateBp: number;
  vendor: Ref;
  item: Ref;
  vendorItemCode: string;
  po: Ref;
  poDate: string;
  origin: 'auto_created_from_invoice' | 'created_from_invoice_on_approval';
  approvedByUserId: string | null;
  grnDate: string;
  confirmedByUserId: string;
  lines: unknown[];
}

/**
 * COMMITTING (ARCHITECTURE §4.3, decision D4).
 *
 * 1. Before the first write, re-run every rule against live ERP data. If anything changed since
 *    validation, go back to MATCHING instead of writing.
 * 2. Execute the staged creations in dependency order, each with its idempotency key
 *    `veyra:<invoiceId>:<actionId>`, recording each ERP id as soon as it is returned.
 * 3. Check the invoice's natural key (vendor, number, FY), then record the purchase invoice.
 * 4. VERIFIED_PENDING_PAYMENT. No payment call exists.
 *
 * A crash anywhere is safe: a re-run skips actions that have an ERP id and re-sends the rest with
 * the same key, and the ERP returns the record it already has for a key it has seen.
 */
export async function executeCommit(
  v: Veyra,
  invoiceId: string,
  plan: CommitPlan | null,
): Promise<void> {
  if (!plan) throw new Error('COMMITTING without a commit plan');
  const erp = v.erp;
  const sys = { type: 'system' as const };
  const inv = v.invoiceRow(v.db, invoiceId);
  const rows = () =>
    v.db.select().from(t.creationActions).where(eq(t.creationActions.invoiceId, invoiceId)).all();
  const started =
    rows().some((r) => plan.actionIds.includes(r.id) && r.status === 'committed') ||
    inv.erpPurchaseInvoiceId !== null;

  const backToMatching = (reason: string, detail: Record<string, JsonValue> = {}) => {
    v.db.transaction((tx) => {
      for (const a of tx
        .select()
        .from(t.creationActions)
        .where(
          and(eq(t.creationActions.invoiceId, invoiceId), eq(t.creationActions.status, 'staged')),
        )
        .all()) {
        tx.update(t.creationActions)
          .set({ status: 'discarded' })
          .where(eq(t.creationActions.id, a.id))
          .run();
      }
      v.audit(tx, invoiceId, sys, 'commit.conflict', { reason, ...detail });
      v.transition(tx, invoiceId, 'COMMITTING', 'MATCHING', sys, { commitPlanJson: null });
      v.enqueue(tx, invoiceId, 'pipeline');
    });
    v.onEnqueue();
  };

  // 1. Pre-commit re-check against live ERP state.
  if (!started) {
    const fresh = await v.engine(invoiceId);
    if (!fresh.plan || canonical(fresh.plan) !== canonical(plan)) {
      backToMatching(
        'Your records changed since the invoice was checked, so Veyra is checking it again.',
      );
      return;
    }
    v.db.transaction((tx) =>
      v.audit(tx, invoiceId, sys, 'commit.started', { actions: plan.actionIds.length }),
    );
  }

  const actionById = (id: string) => rows().find((r) => r.id === id);
  const refId = (ref: Ref): ErpId => {
    if (ref.kind === 'erp') return ref.id as ErpId;
    const a = actionById(ref.actionId);
    if (!a?.erpId) throw new PlanChanged(`staged record ${ref.actionId} is not in the ERP yet`);
    return a.erpId as ErpId;
  };
  const poLineId = async (ref: PoLineRef): Promise<ErpId> => {
    if (ref.kind === 'erp') return ref.id as ErpId;
    const po = await erp.getPurchaseOrder(refId({ kind: 'staged', actionId: ref.actionId }));
    const line = po?.lines.find((l) => l.lineNo === ref.lineNo);
    if (!line) throw new PlanChanged(`order line ${ref.lineNo} not found`);
    return line.id;
  };
  const source = invoiceId as InvoiceId;

  try {
    // 2. Staged creations, in dependency order.
    for (const actionId of plan.actionIds) {
      const a = actionById(actionId);
      if (!a || a.status === 'discarded')
        throw new PlanChanged(`action ${actionId} is no longer staged`);
      if (a.status === 'committed') continue;
      const key = a.idempotencyKey as IdempotencyKey;
      const p = JSON.parse(a.payloadJson) as StagedPayload;
      let erpId: string;
      let label: string;
      switch (a.entity) {
        case 'vendor_reactivation': {
          const r = await erp.reactivateVendor(
            {
              vendorId: p.vendorId,
              sourceInvoiceId: source,
              approvedByUserId: a.approvedByUserId as never,
            },
            key,
          );
          [erpId, label] = [r.id, `${r.name} (${r.code}) reactivated`];
          break;
        }
        case 'vendor': {
          const r = await erp.createVendor(
            { name: p.name, gstin: p.gstin, address: p.address, sourceInvoiceId: source },
            key,
          );
          [erpId, label] = [r.id, `Supplier ${r.name} added as ${r.code}`];
          break;
        }
        case 'item': {
          const r = await erp.createItem(
            {
              name: p.name,
              hsnSac: p.hsnSac,
              uom: p.uom,
              gstRateBp: p.gstRateBp,
              sourceInvoiceId: source,
              approvedByUserId: a.approvedByUserId as never,
            },
            key,
          );
          [erpId, label] = [r.id, `Item ${r.name} added as ${r.code}`];
          break;
        }
        case 'alias': {
          const r = await erp.createVendorItemAlias(
            {
              vendorId: refId(p.vendor),
              vendorItemCode: p.vendorItemCode,
              itemId: refId(p.item),
              sourceInvoiceId: source,
            },
            key,
          );
          [erpId, label] = [r.id, `Supplier item code ${r.vendorItemCode} linked to the item`];
          break;
        }
        case 'po': {
          const lines = (
            p.lines as unknown as {
              lineNo: number;
              item: Ref;
              qtyMilli: number;
              unitPricePaise: number;
              gstRateBp: number;
            }[]
          ).map((l) => ({
            lineNo: l.lineNo,
            itemId: refId(l.item),
            qtyMilli: l.qtyMilli as never,
            unitPricePaise: l.unitPricePaise as never,
            gstRateBp: l.gstRateBp as never,
          }));
          const r = await erp.createPurchaseOrder(
            {
              vendorId: refId(p.vendor),
              poDate: p.poDate,
              origin: p.origin,
              sourceInvoiceId: source,
              approvedByUserId: p.approvedByUserId,
              lines,
            },
            key,
          );
          [erpId, label] = [
            r.id,
            `Purchase order ${r.poNumber} created (${r.origin.replaceAll('_', ' ')})`,
          ];
          break;
        }
        case 'grn': {
          const lines = [];
          for (const l of p.lines as unknown as {
            poLine: PoLineRef;
            receivedQtyMilli: number;
            acceptedQtyMilli: number;
          }[]) {
            lines.push({
              poLineId: await poLineId(l.poLine),
              receivedQtyMilli: l.receivedQtyMilli as never,
              acceptedQtyMilli: l.acceptedQtyMilli as never,
            });
          }
          const r = await erp.createGrn(
            {
              poId: refId(p.po),
              grnDate: p.grnDate,
              confirmedByUserId: p.confirmedByUserId,
              sourceInvoiceId: source,
              lines,
            },
            key,
          );
          [erpId, label] = [r.id, `Goods receipt ${r.grnNumber} recorded`];
          break;
        }
        default:
          throw new Error(`unknown creation ${a.entity}`);
      }
      v.commitHooks.afterErpWrite?.(a.entity, erpId);
      const now = v.now();
      v.db.transaction((tx) => {
        tx.update(t.creationActions)
          .set({ status: 'committed', erpId, committedAt: now })
          .where(eq(t.creationActions.id, a.id))
          .run();
        v.audit(tx, invoiceId, sys, 'creation.committed', {
          actionId: a.id,
          entity: a.entity,
          erpId,
          label,
          policyCode: a.policyCode,
        });
      });
    }

    // 3. The purchase invoice, after checking its natural key.
    const vendorId = refId(plan.vendor);
    const poId = refId(plan.po);
    const inv2 = plan.invoice;
    const fy = financialYearOf(inv2.invoiceDate as IsoDate);
    const existing = await erp.findPurchaseInvoice(
      vendorId,
      normalizeInvoiceNumber(inv2.vendorInvoiceNo),
      fy,
    );
    if (existing && existing.veyraInvoiceId !== invoiceId) {
      backToMatching('The same invoice was recorded in the ERP meanwhile.', {
        existing: existing.id,
      });
      return;
    }
    const lines = [];
    for (const l of inv2.lines) {
      lines.push({
        lineNo: l.lineNo,
        poLineId: await poLineId(l.poLine),
        itemId: refId(l.item),
        qtyMilli: l.qtyMilli as never,
        unitPricePaise: l.unitPricePaise as never,
        taxablePaise: l.taxablePaise as never,
        gstRateBp: l.gstRateBp as never,
        cgstPaise: l.cgstPaise as never,
        sgstPaise: l.sgstPaise as never,
        igstPaise: l.igstPaise as never,
      });
    }
    const recorded =
      existing ??
      (await erp.recordPurchaseInvoice(
        {
          vendorId,
          vendorInvoiceNo: inv2.vendorInvoiceNo,
          invoiceDate: inv2.invoiceDate,
          poId,
          taxablePaise: inv2.taxablePaise as never,
          cgstPaise: inv2.cgstPaise as never,
          sgstPaise: inv2.sgstPaise as never,
          igstPaise: inv2.igstPaise as never,
          roundOffPaise: inv2.roundOffPaise as never,
          totalPaise: inv2.totalPaise as never,
          veyraInvoiceId: source,
          lines,
        },
        purchaseInvoiceIdempotencyKey(source),
      ));
    v.commitHooks.afterErpWrite?.('purchase_invoice', recorded.id);

    // 4. Verified. Payment stays outside Veyra.
    v.db.transaction((tx) => {
      v.audit(tx, invoiceId, sys, 'commit.completed', {
        purchaseInvoiceId: recorded.id,
        vendorErpId: vendorId,
        poErpId: poId,
        status: recorded.status,
      });
      v.transition(tx, invoiceId, 'COMMITTING', 'VERIFIED_PENDING_PAYMENT', sys, {
        erpPurchaseInvoiceId: recorded.id,
        vendorErpId: vendorId,
        poErpId: poId,
      });
    });
  } catch (error) {
    if (error instanceof ErpConflictError) {
      backToMatching(
        'A record Veyra was about to create now exists in your ERP. Veyra is checking again.',
        { entity: error.entity, existingId: error.existingId },
      );
      return;
    }
    if (error instanceof PlanChanged) {
      backToMatching(error.message);
      return;
    }
    throw error;
  }
}
