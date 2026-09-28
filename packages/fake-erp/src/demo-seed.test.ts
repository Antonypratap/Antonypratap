import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErpIdSchema, normalizeName } from '@veyra/shared';
import { validateGstin, type Gstin, type Pan } from '@veyra/india-tax';
import type { FakeErpConnector } from './index';
import { tempErp } from './test/temp-db';

/** Verifies the seeded ERP matches docs/DEMO.md §1.2–1.5, read only through ErpConnector. */
const id = (s: string) => ErpIdSchema.parse(s);
const gstin = (g: string): Gstin => {
  const r = validateGstin(g);
  if (!r.ok) throw new Error(g);
  return r.value.gstin;
};

let t: ReturnType<typeof tempErp>;
let erp: FakeErpConnector;
beforeAll(() => {
  t = tempErp({ reset: 'demo' });
  erp = t.erp;
});
afterAll(() => t.cleanup());

describe('DEMO.md §1.2 company', () => {
  it('is Veyra Demo Industries, Karnataka', async () => {
    expect(await erp.getCompany()).toEqual({
      id: 'company',
      name: 'Veyra Demo Industries Pvt Ltd',
      gstin: '29AAACS1111A1Z6',
      stateCode: '29',
    });
  });
});

describe('DEMO.md §1.3 vendors', () => {
  const expected = [
    ['V001', 'Shakti Steel Suppliers Pvt Ltd', '29AAFCS5678K1ZK', '29', 'active'],
    ['V002', 'Apex Components Pvt Ltd', '27AAACA4321M1ZT', '27', 'active'],
    ['V003', 'Bharat Packaging', '29ABCPB2468Q1Z9', '29', 'inactive'],
    ['V004', 'Kaveri Tools & Hardware Pvt Ltd', '33AAHCK1357R1Z3', '33', 'active'],
    ['V005', 'Vasudha Traders', '29AAACV1234F1ZL', '29', 'active'],
    ['V006', 'Vasudha Traders & Co', '29AAJFV2222B1ZG', '29', 'active'],
    ['V007', 'Eastline Office Supplies Pvt Ltd', '29AAKCE3344D1ZP', '29', 'active'],
  ] as const;

  it.each(expected)('%s %s', async (code, name, g, state, status) => {
    const v = await erp.findVendorByGstin(gstin(g));
    expect(v).toMatchObject({
      id: code,
      code,
      name,
      gstin: g,
      stateCode: state,
      status,
      origin: 'seed',
      sourceInvoiceId: null,
    });
    expect(v?.pan).toBe(g.slice(2, 12));
  });

  it('V005 and V006 share a normalised name (S17 ambiguity)', async () => {
    const both = await erp.findVendorsByNormalizedName(normalizeName('Vasudha Traders'));
    expect(both.map((v) => v.code)).toEqual(['V005', 'V006']);
  });

  it('the invoice-only vendors are not in the ERP', async () => {
    expect(await erp.findVendorByGstin(gstin('29AADCN9753P1ZH'))).toBeNull(); // Nandi
    expect(await erp.findVendorsByPan('AAGCM4455J' as Pan)).toEqual([]); // Meridian
  });
});

describe('DEMO.md §1.4 items', () => {
  const expected = [
    ['ITM-001', 'MS Steel Rod 12mm', '7214', 'KGS', 1800],
    ['ITM-002', 'MS Steel Plate 6mm', '7208', 'KGS', 1800],
    ['ITM-003', 'Ball Bearing 6204 ZZ', '8482', 'NOS', 1800],
    ['ITM-004', 'Corrugated Box 5 Ply', '4819', 'NOS', 1200],
    ['ITM-005', 'A4 Copier Paper 75 GSM', '4802', 'REAM', 1200],
    ['ITM-006', 'Cutting Disc 4 inch', '6804', 'NOS', 1800],
    ['ITM-007', 'Printer Toner Cartridge 88A', '8443', 'NOS', 1800],
  ] as const;

  it.each(expected)('%s %s (GST in basis points)', async (code, name, hsn, uom, rate) => {
    expect(await erp.getItem(id(code))).toMatchObject({
      code,
      name,
      hsnSac: hsn,
      uom,
      gstRateBp: rate,
      origin: 'seed',
    });
  });

  it('no items for HSN 9608 or 7318; S03 paper is findable by name + HSN', async () => {
    expect(await erp.findItemsByHsn('9608')).toEqual([]);
    expect(await erp.findItemsByHsn('7318')).toEqual([]);
    const paper = await erp.findItemsByNormalizedNameAndHsn(
      normalizeName('A4 Copier Paper 75 GSM'),
      '4802',
    );
    expect(paper.map((i) => i.code)).toEqual(['ITM-005']);
  });

  it('no vendor-item aliases are seeded (S02 creates one)', async () => {
    expect(await erp.findItemByVendorAlias(id('V002'), 'BRG-6204ZZ')).toBeNull();
  });
});

describe('DEMO.md §1.5 purchase orders and GRNs', () => {
  // [po, vendor, date, status, [item, qty milli, price paise, rate bp][], grn number, accepted milli[]]
  const expected = [
    [
      'PO-2026-0099',
      'V001',
      '2026-08-05',
      'closed',
      [['ITM-001', 100_000, 6250, 1800]],
      'GRN-2026-0199',
      [100_000],
    ],
    [
      'PO-2026-0101',
      'V001',
      '2026-09-01',
      'open',
      [
        ['ITM-001', 1_000_000, 6250, 1800],
        ['ITM-002', 500_000, 6800, 1800],
      ],
      'GRN-2026-0201',
      [1_000_000, 500_000],
    ],
    [
      'PO-2026-0102',
      'V001',
      '2026-09-02',
      'open',
      [['ITM-001', 200_000, 6250, 1800]],
      'GRN-2026-0202',
      [180_000],
    ],
    [
      'PO-2026-0103',
      'V002',
      '2026-09-03',
      'open',
      [['ITM-003', 100_000, 14_500, 1800]],
      'GRN-2026-0203',
      [100_000],
    ],
    ['PO-2026-0104', 'V002', '2026-09-04', 'open', [['ITM-003', 50_000, 14_500, 1800]], null, []],
    [
      'PO-2026-0105',
      'V004',
      '2026-09-05',
      'open',
      [['ITM-006', 200_000, 3800, 1800]],
      'GRN-2026-0204',
      [200_000],
    ],
    [
      'PO-2026-0106',
      'V004',
      '2026-09-06',
      'open',
      [['ITM-006', 100_000, 3800, 1800]],
      'GRN-2026-0205',
      [100_000],
    ],
    [
      'PO-2026-0107',
      'V003',
      '2026-09-07',
      'open',
      [['ITM-004', 500_000, 2400, 1200]],
      'GRN-2026-0206',
      [500_000],
    ],
    [
      'PO-2026-0108',
      'V005',
      '2026-09-08',
      'open',
      [['ITM-007', 10_000, 245_000, 1800]],
      'GRN-2026-0207',
      [10_000],
    ],
    [
      'PO-2026-0109',
      'V001',
      '2026-09-09',
      'open',
      [['ITM-002', 100_000, 6800, 1800]],
      'GRN-2026-0208',
      [100_000],
    ],
    [
      'PO-2026-0110',
      'V001',
      '2026-09-10',
      'open',
      [['ITM-001', 100_000, 6250, 1800]],
      'GRN-2026-0209',
      [100_000],
    ],
    [
      'PO-2026-0111',
      'V002',
      '2026-09-11',
      'open',
      [['ITM-003', 20_000, 14_500, 1800]],
      'GRN-2026-0210',
      [20_000],
    ],
    [
      'PO-2026-0112',
      'V001',
      '2026-09-12',
      'open',
      [['ITM-002', 200_000, 6800, 1800]],
      'GRN-2026-0211',
      [200_000],
    ],
  ] as const;

  it.each(expected)('%s', async (poNumber, vendor, date, status, lines, grnNumber, accepted) => {
    const po = await erp.getPurchaseOrderByNumber(poNumber);
    expect(po).toMatchObject({
      poNumber,
      vendorId: vendor,
      poDate: date,
      status,
      origin: 'seed',
      sourceInvoiceId: null,
    });
    expect(po?.lines.map((l) => [l.itemId, l.qtyMilli, l.unitPricePaise, l.gstRateBp])).toEqual(
      lines,
    );
    expect(po?.lines.map((l) => l.lineNo)).toEqual(lines.map((_, i) => i + 1));

    const grnList = await erp.listGrnsForPo(id(poNumber));
    if (grnNumber === null) {
      expect(grnList).toEqual([]);
      return;
    }
    expect(grnList).toHaveLength(1);
    const grn = grnList[0];
    expect(grn).toMatchObject({
      grnNumber,
      poId: po?.id,
      grnDate: date,
      origin: 'seed',
      confirmedByUserId: null,
    });
    // Every GRN line points at a line of its own PO, in order; received = accepted (DEMO gives one figure).
    expect(grn?.lines.map((l) => l.poLineId)).toEqual(po?.lines.map((l) => l.id));
    expect(grn?.lines.map((l) => l.acceptedQtyMilli)).toEqual(accepted);
    expect(grn?.lines.map((l) => l.receivedQtyMilli)).toEqual(accepted);
  });

  it('units are exact integers: ₹2,450.00 = 245000 paise, 1000 KGS = 1,000,000 milli', async () => {
    const toner = await erp.getPurchaseOrderByNumber('PO-2026-0108');
    expect(toner?.lines[0]?.unitPricePaise).toBe(245_000);
    const rods = await erp.getPurchaseOrderByNumber('PO-2026-0101');
    expect(rods?.lines[0]?.qtyMilli).toBe(1_000_000);
    for (const po of expected) {
      for (const [, qty, price, rate] of po[4]) {
        expect(Number.isInteger(qty) && Number.isInteger(price) && Number.isInteger(rate)).toBe(
          true,
        );
      }
    }
  });

  it('open POs per vendor exclude the closed PO (S07, S18 assumptions)', async () => {
    const open = async (v: string) =>
      (await erp.listOpenPurchaseOrders(id(v))).map((p) => p.poNumber);
    expect(await open('V004')).toEqual(['PO-2026-0105', 'PO-2026-0106']);
    expect(await open('V007')).toEqual([]);
    expect(await open('V001')).toEqual([
      'PO-2026-0101',
      'PO-2026-0102',
      'PO-2026-0109',
      'PO-2026-0110',
      'PO-2026-0112',
    ]);
  });

  it('nothing has been invoiced and no purchase invoices are seeded', async () => {
    for (const po of expected) {
      const p = await erp.getPurchaseOrderByNumber(po[0]);
      for (const line of p?.lines ?? []) expect(await erp.getInvoicedQtyByPoLine(line.id)).toBe(0);
    }
  });
});
