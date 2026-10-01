import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErpIdSchema } from '@veyra/shared';
import { isValidGstin } from '@veyra/india-tax';
import type { FakeErpConnector } from './index';
import { tempErp } from './test/temp-db';

/** The brewery sample business (docs/DEMO.md §10), read only through ErpConnector. */
const id = (s: string) => ErpIdSchema.parse(s);
let t: ReturnType<typeof tempErp>;
let erp: FakeErpConnector;
beforeAll(() => {
  t = tempErp({ reset: 'demo', business: 'brewery' });
  erp = t.erp;
});
afterAll(() => t.cleanup());

describe('brewery seed', () => {
  it('is Hopsmith Brewing Co., Karnataka', async () => {
    expect(await erp.getCompany()).toEqual({
      id: 'company',
      name: 'Hopsmith Brewing Co. Pvt Ltd',
      gstin: '29AAICH4826L1Z2',
      stateCode: '29',
    });
  });

  it('every GSTIN passes the checksum and matches its state; one supplier is inactive', async () => {
    const vendors = await erp.listVendors();
    expect(vendors).toHaveLength(7);
    for (const v of vendors) {
      expect(isValidGstin(v.gstin ?? ''), v.name).toBe(true);
      expect(v.gstin?.slice(0, 2)).toBe(v.stateCode);
    }
    expect(vendors.filter((v) => v.status === 'inactive').map((v) => v.name)).toEqual([
      'Deccan Glass Works',
    ]);
  });

  it('every order line names a seeded item; the missing-receipt order has no receipt', async () => {
    const items = new Set((await erp.listItems()).map((i) => i.id));
    for (const po of await erp.listPurchaseOrders()) {
      expect(po.lines.length, po.poNumber).toBeGreaterThan(0);
      for (const l of po.lines) expect(items.has(l.itemId), po.poNumber).toBe(true);
    }
    const missing = await erp.getPurchaseOrderByNumber('PO-2026-1105');
    expect(missing).not.toBeNull();
    expect(await erp.listGrnsForPo(id(missing?.id ?? ''))).toEqual([]);
  });

  it('a reset gives the same brewery again; the default business stays manufacturing', async () => {
    erp.reset('demo');
    expect((await erp.getCompany()).name).toBe('Hopsmith Brewing Co. Pvt Ltd');
    const plain = tempErp({ reset: 'demo' });
    expect((await plain.erp.getCompany()).name).toBe('Veyra Demo Industries Pvt Ltd');
    plain.cleanup();
  });
});
