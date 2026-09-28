import { normalizeName } from '@veyra/shared';
import type { FakeErpDb } from '../db/open';
import {
  company,
  grnLines,
  grns,
  items,
  poLines,
  purchaseOrders,
  vendors,
  TABLES_IN_DEPENDENCY_ORDER,
} from '../db/schema';
import { grnId, grnLineId, itemId, poId, poLineId, vendorId } from '../ids';
import {
  DEMO_COMPANY,
  DEMO_ITEMS,
  DEMO_PURCHASE_ORDERS,
  DEMO_VENDORS,
  SEED_CREATED_AT,
} from './demo-data';

export type FakeErpSeed = 'demo' | 'company-only';

/**
 * Deterministic reset: in one transaction, delete every row (children first, including the
 * idempotency log) and insert the seed. Running it any number of times yields the same state.
 */
export function resetAndSeed(db: FakeErpDb, seed: FakeErpSeed): void {
  db.transaction(
    (tx) => {
      for (const table of [...TABLES_IN_DEPENDENCY_ORDER].reverse()) tx.delete(table).run();
      tx.insert(company).values(DEMO_COMPANY).run();
      if (seed === 'company-only') return;

      for (const v of DEMO_VENDORS) {
        tx.insert(vendors)
          .values({
            id: vendorId(v.code),
            code: v.code,
            name: v.name,
            nameNormalized: normalizeName(v.name),
            gstin: v.gstin,
            pan: v.gstin.slice(2, 12),
            stateCode: v.gstin.slice(0, 2),
            address: v.address,
            status: v.status,
            origin: 'seed',
            sourceInvoiceId: null,
            createdAt: SEED_CREATED_AT,
          })
          .run();
      }
      for (const i of DEMO_ITEMS) {
        tx.insert(items)
          .values({
            id: itemId(i.code),
            code: i.code,
            name: i.name,
            nameNormalized: normalizeName(i.name),
            hsnSac: i.hsnSac,
            uom: i.uom,
            gstRateBp: i.gstRateBp,
            origin: 'seed',
            sourceInvoiceId: null,
            createdAt: SEED_CREATED_AT,
          })
          .run();
      }
      for (const po of DEMO_PURCHASE_ORDERS) {
        const id = poId(po.poNumber);
        tx.insert(purchaseOrders)
          .values({
            id,
            poNumber: po.poNumber,
            vendorId: vendorId(po.vendorCode),
            poDate: po.poDate,
            status: po.status,
            origin: 'seed',
            sourceInvoiceId: null,
            approvedByUserId: null,
            createdAt: SEED_CREATED_AT,
          })
          .run();
        po.lines.forEach((line, i) => {
          const itemRow = DEMO_ITEMS.find((it) => it.code === line.itemCode);
          if (!itemRow) throw new Error(`seed: unknown item ${line.itemCode}`);
          tx.insert(poLines)
            .values({
              id: poLineId(id, i + 1),
              poId: id,
              lineNo: i + 1,
              itemId: itemId(line.itemCode),
              qtyMilli: line.qtyMilli,
              unitPricePaise: line.unitPricePaise,
              gstRateBp: itemRow.gstRateBp,
            })
            .run();
        });
        if (po.grn) {
          const gid = grnId(po.grn.grnNumber);
          tx.insert(grns)
            .values({
              id: gid,
              grnNumber: po.grn.grnNumber,
              poId: id,
              grnDate: po.poDate,
              origin: 'seed',
              confirmedByUserId: null,
              sourceInvoiceId: null,
              createdAt: SEED_CREATED_AT,
            })
            .run();
          po.grn.acceptedQtyMilli.forEach((accepted, i) => {
            tx.insert(grnLines)
              .values({
                id: grnLineId(gid, i + 1),
                grnId: gid,
                poLineId: poLineId(id, i + 1),
                receivedQtyMilli: accepted,
                acceptedQtyMilli: accepted,
              })
              .run();
          });
        }
      }
    },
    { behavior: 'immediate' },
  );
}
