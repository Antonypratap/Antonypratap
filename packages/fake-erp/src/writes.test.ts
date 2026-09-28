import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CreationActionIdSchema,
  ErpIdSchema,
  InvoiceIdSchema,
  UserIdSchema,
  creationIdempotencyKey,
  normalizeInvoiceNumber,
  purchaseInvoiceIdempotencyKey,
} from '@veyra/shared';
import { validateGstin, type FinancialYear, type Gstin } from '@veyra/india-tax';
import type { RecordPurchaseInvoiceInput } from '@veyra/erp-connector';
import type { FakeErpConnector } from './index';
import { tempErp } from './test/temp-db';

const ulid = (n: number) => n.toString().padStart(26, '0');
const INVOICE = InvoiceIdSchema.parse(ulid(1));
const INVOICE_2 = InvoiceIdSchema.parse(ulid(2));
const USER = UserIdSchema.parse(ulid(9));
let n = 100;
const key = (inv = INVOICE) => creationIdempotencyKey(inv, CreationActionIdSchema.parse(ulid(n++)));
const id = (s: string) => ErpIdSchema.parse(s);
const gstin = (g: string): Gstin => {
  const r = validateGstin(g);
  if (!r.ok) throw new Error(g);
  return r.value.gstin;
};

const FIXED_NOW = new Date('2026-09-28T05:00:00.000Z');
let t: ReturnType<typeof tempErp>;
let erp: FakeErpConnector;
beforeEach(() => {
  t = tempErp({ reset: 'demo', clock: () => FIXED_NOW });
  erp = t.erp;
});
afterEach(() => t.cleanup());

/** DEMO S01: Shakti SSS/26-27/0451 against PO-2026-0101, both lines in full. */
const s01 = (over: Partial<RecordPurchaseInvoiceInput> = {}): RecordPurchaseInvoiceInput => ({
  vendorId: 'V001',
  vendorInvoiceNo: 'SSS/26-27/0451',
  invoiceDate: '2026-09-15',
  poId: 'PO-2026-0101',
  taxablePaise: 9_650_000,
  cgstPaise: 868_500,
  sgstPaise: 868_500,
  igstPaise: 0,
  roundOffPaise: null,
  totalPaise: 11_387_000,
  veyraInvoiceId: INVOICE,
  lines: [
    {
      lineNo: 1,
      poLineId: 'PO-2026-0101#1',
      itemId: 'ITM-001',
      qtyMilli: 1_000_000,
      unitPricePaise: 6250,
      taxablePaise: 6_250_000,
      gstRateBp: 1800,
      cgstPaise: 562_500,
      sgstPaise: 562_500,
      igstPaise: null,
    },
    {
      lineNo: 2,
      poLineId: 'PO-2026-0101#2',
      itemId: 'ITM-002',
      qtyMilli: 500_000,
      unitPricePaise: 6800,
      taxablePaise: 3_400_000,
      gstRateBp: 1800,
      cgstPaise: 306_000,
      sgstPaise: 306_000,
      igstPaise: null,
    },
  ],
  ...over,
});

const line = (i: number) => {
  const l = s01().lines[i];
  if (!l) throw new Error(`no line ${i}`);
  return l;
};

describe('vendor writes', () => {
  it('creates the next vendor code with derived fields and the injected clock (S03 Nandi)', async () => {
    const v = await erp.createVendor(
      {
        name: 'Nandi Stationers Pvt Ltd',
        gstin: '29AADCN9753P1ZH',
        address: 'Bengaluru',
        sourceInvoiceId: INVOICE,
      },
      key(),
    );
    expect(v).toMatchObject({
      id: 'V008',
      code: 'V008',
      pan: 'AADCN9753P',
      stateCode: '29',
      nameNormalized: 'nandi stationers',
      status: 'active',
      origin: 'created_by_veyra',
      createdAt: FIXED_NOW.toISOString(),
    });
  });

  it('refuses a GSTIN that already exists in the seed', async () => {
    await expect(
      erp.createVendor(
        { name: 'Shakti', gstin: '29AAFCS5678K1ZK', address: 'x', sourceInvoiceId: INVOICE },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', existingId: 'V001' });
  });

  it('reactivates the inactive seed vendor (S16 Bharat)', async () => {
    expect((await erp.getVendor(id('V003')))?.status).toBe('inactive');
    const v = await erp.reactivateVendor(
      { vendorId: 'V003', sourceInvoiceId: INVOICE, approvedByUserId: USER },
      key(),
    );
    expect(v.status).toBe('active');
    expect((await erp.getVendor(id('V003')))?.status).toBe('active');
  });
});

describe('item and alias writes', () => {
  it('creates the next item code (S05 marker)', async () => {
    const item = await erp.createItem(
      {
        name: 'Whiteboard Marker Box of 10',
        hsnSac: '9608',
        uom: 'BOX',
        gstRateBp: 1800,
        sourceInvoiceId: INVOICE,
        approvedByUserId: USER,
      },
      key(),
    );
    expect(item).toMatchObject({
      id: 'ITM-008',
      code: 'ITM-008',
      origin: 'created_by_veyra',
      sourceInvoiceId: INVOICE,
    });
    expect((await erp.findItemsByHsn('9608')).map((i) => i.id)).toEqual(['ITM-008']);
  });

  it('creates an alias (S02 BRG-6204ZZ → ITM-003) and resolves it', async () => {
    const alias = await erp.createVendorItemAlias(
      {
        vendorId: 'V002',
        vendorItemCode: 'BRG-6204ZZ',
        itemId: 'ITM-003',
        sourceInvoiceId: INVOICE,
      },
      key(),
    );
    expect(alias.id).toBe('ALIAS-0001');
    expect((await erp.findItemByVendorAlias(id('V002'), 'BRG-6204ZZ'))?.code).toBe('ITM-003');
    expect(await erp.findItemByVendorAlias(id('V001'), 'BRG-6204ZZ')).toBeNull();
  });
});

describe('purchase order writes', () => {
  it('numbers auto POs per financial year and stores lines exactly', async () => {
    const po = await erp.createPurchaseOrder(
      {
        vendorId: 'V007',
        poDate: '2026-09-18',
        origin: 'created_from_invoice_on_approval',
        sourceInvoiceId: INVOICE,
        approvedByUserId: USER,
        lines: [
          {
            lineNo: 1,
            itemId: 'ITM-007',
            qtyMilli: 12_000,
            unitPricePaise: 245_000,
            gstRateBp: 1800,
          },
        ],
      },
      key(),
    );
    expect(po).toMatchObject({
      id: 'AUTO/2026-27/1',
      poNumber: 'AUTO/2026-27/1',
      status: 'open',
      approvedByUserId: USER,
    });
    expect(po.lines).toEqual([
      {
        id: 'AUTO/2026-27/1#1',
        poId: 'AUTO/2026-27/1',
        lineNo: 1,
        itemId: 'ITM-007',
        qtyMilli: 12_000,
        unitPricePaise: 245_000,
        gstRateBp: 1800,
      },
    ]);
    const second = await erp.createPurchaseOrder(
      {
        vendorId: 'V007',
        poDate: '2026-09-19',
        origin: 'auto_created_from_invoice',
        sourceInvoiceId: INVOICE_2,
        approvedByUserId: null,
        lines: [
          { lineNo: 1, itemId: 'ITM-005', qtyMilli: 1000, unitPricePaise: 100, gstRateBp: 1200 },
        ],
      },
      key(INVOICE_2),
    );
    expect(second.poNumber).toBe('AUTO/2026-27/2');
    expect((await erp.listOpenPurchaseOrders(id('V007'))).map((p) => p.poNumber)).toEqual([
      'AUTO/2026-27/1',
      'AUTO/2026-27/2',
    ]);
  });

  it('refuses unknown items', async () => {
    await expect(
      erp.createPurchaseOrder(
        {
          vendorId: 'V007',
          poDate: '2026-09-18',
          origin: 'auto_created_from_invoice',
          sourceInvoiceId: INVOICE,
          approvedByUserId: null,
          lines: [
            { lineNo: 1, itemId: 'ITM-999', qtyMilli: 1000, unitPricePaise: 100, gstRateBp: 1800 },
          ],
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', entity: 'item' });
  });
});

describe('GRN writes', () => {
  it('records a user-confirmed GRN for the PO without one (S08 PO-2026-0104)', async () => {
    const grn = await erp.createGrn(
      {
        poId: 'PO-2026-0104',
        grnDate: '2026-09-20',
        confirmedByUserId: USER,
        sourceInvoiceId: INVOICE,
        lines: [{ poLineId: 'PO-2026-0104#1', receivedQtyMilli: 50_000, acceptedQtyMilli: 40_000 }],
      },
      key(),
    );
    expect(grn).toMatchObject({
      grnNumber: 'GRN/2026-27/1',
      origin: 'user_confirmed_via_veyra',
      confirmedByUserId: USER,
    });
    expect(grn.lines).toEqual([
      {
        id: 'GRN/2026-27/1#1',
        grnId: 'GRN/2026-27/1',
        poLineId: 'PO-2026-0104#1',
        receivedQtyMilli: 50_000,
        acceptedQtyMilli: 40_000,
      },
    ]);
    expect((await erp.listGrnsForPo(id('PO-2026-0104'))).map((g) => g.grnNumber)).toEqual([
      'GRN/2026-27/1',
    ]);
  });

  it('adds a second GRN to a PO that already has one (S10 additional receipt)', async () => {
    await erp.createGrn(
      {
        poId: 'PO-2026-0102',
        grnDate: '2026-09-22',
        confirmedByUserId: USER,
        sourceInvoiceId: INVOICE,
        lines: [{ poLineId: 'PO-2026-0102#1', receivedQtyMilli: 20_000, acceptedQtyMilli: 20_000 }],
      },
      key(),
    );
    const grnList = await erp.listGrnsForPo(id('PO-2026-0102'));
    expect(grnList.map((g) => g.grnNumber)).toEqual(['GRN-2026-0202', 'GRN/2026-27/1']);
    expect(grnList.flatMap((g) => g.lines).reduce((a, l) => a + l.acceptedQtyMilli, 0)).toBe(
      200_000,
    );
  });

  it('refuses PO lines of another PO', async () => {
    await expect(
      erp.createGrn(
        {
          poId: 'PO-2026-0104',
          grnDate: '2026-09-20',
          confirmedByUserId: USER,
          sourceInvoiceId: INVOICE,
          lines: [{ poLineId: 'PO-2026-0103#1', receivedQtyMilli: 1000, acceptedQtyMilli: 1000 }],
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await erp.listGrnsForPo(id('PO-2026-0104'))).toEqual([]);
  });
});

describe('purchase invoice writes', () => {
  it('records S01 with both lines, per-FY number and invoiced quantities', async () => {
    const inv = await erp.recordPurchaseInvoice(s01(), purchaseInvoiceIdempotencyKey(INVOICE));
    expect(inv).toMatchObject({
      id: 'PINV/2026-27/1',
      vendorInvoiceNoNormalized: 'SSS/26-27/0451',
      fy: '2026-27',
      status: 'verified_pending_payment',
      totalPaise: 11_387_000,
    });
    expect(inv.lines.map((l) => [l.id, l.lineNo, l.qtyMilli, l.taxablePaise])).toEqual([
      ['PINV/2026-27/1#1', 1, 1_000_000, 6_250_000],
      ['PINV/2026-27/1#2', 2, 500_000, 3_400_000],
    ]);
    expect(await erp.getInvoicedQtyByPoLine(id('PO-2026-0101#1'))).toBe(1_000_000);
    expect(await erp.getInvoicedQtyByPoLine(id('PO-2026-0101#2'))).toBe(500_000);
    expect((await erp.listOpenPurchaseOrders(id('V001'))).map((p) => p.poNumber)).not.toContain(
      'PO-2026-0101',
    );
  });

  it('keeps a partially invoiced PO open', async () => {
    const partial = s01({
      taxablePaise: 6_250_000,
      cgstPaise: 562_500,
      sgstPaise: 562_500,
      totalPaise: 7_375_000,
      lines: [line(0)],
    });
    await erp.recordPurchaseInvoice(partial, purchaseInvoiceIdempotencyKey(INVOICE));
    expect((await erp.listOpenPurchaseOrders(id('V001'))).map((p) => p.poNumber)).toContain(
      'PO-2026-0101',
    );
  });

  it('prevents duplicates by vendor + normalised number + FY (S11b)', async () => {
    const first = await erp.recordPurchaseInvoice(s01(), purchaseInvoiceIdempotencyKey(INVOICE));
    await expect(
      erp.recordPurchaseInvoice(
        s01({ vendorInvoiceNo: 'sss/26-27/ 0451', veyraInvoiceId: INVOICE_2 }),
        purchaseInvoiceIdempotencyKey(INVOICE_2),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', existingId: first.id });
    const found = await erp.findPurchaseInvoice(
      id('V001'),
      normalizeInvoiceNumber('SSS/26-27/0451'),
      '2026-27' as FinancialYear,
    );
    expect(found?.id).toBe(first.id);
    expect(await erp.getInvoicedQtyByPoLine(id('PO-2026-0101#1'))).toBe(1_000_000);
  });

  it('the same number in another financial year is a different invoice', async () => {
    await erp.recordPurchaseInvoice(s01(), purchaseInvoiceIdempotencyKey(INVOICE));
    const nextYear = await erp.recordPurchaseInvoice(
      s01({
        invoiceDate: '2027-04-02',
        veyraInvoiceId: INVOICE_2,
        lines: [{ ...line(0), qtyMilli: 1_000_000 }, line(1)],
      }),
      purchaseInvoiceIdempotencyKey(INVOICE_2),
    );
    expect(nextYear).toMatchObject({ id: 'PINV/2027-28/1', fy: '2027-28' });
  });

  it('refuses a key that is not the invoice key, and lines from another PO', async () => {
    await expect(erp.recordPurchaseInvoice(s01(), key())).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const foreignLine = s01({
      lines: [{ ...line(0), poLineId: 'PO-2026-0110#1' }, line(1)],
    });
    await expect(
      erp.recordPurchaseInvoice(foreignLine, purchaseInvoiceIdempotencyKey(INVOICE)),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(
      await erp.findPurchaseInvoice(id('V001'), 'SSS/26-27/0451', '2026-27' as FinancialYear),
    ).toBeNull();
  });

  it('refuses unknown vendors and POs', async () => {
    await expect(
      erp.recordPurchaseInvoice(s01({ vendorId: 'V999' }), purchaseInvoiceIdempotencyKey(INVOICE)),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      entity: 'vendor',
    });
    await expect(
      erp.recordPurchaseInvoice(s01({ poId: 'PO-X' }), purchaseInvoiceIdempotencyKey(INVOICE)),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      entity: 'purchase_order',
    });
  });
});

describe('the connector never decides', () => {
  it('reports both open Kaveri POs rather than choosing one (S07)', async () => {
    expect((await erp.listOpenPurchaseOrders(id('V004'))).map((p) => p.poNumber)).toEqual([
      'PO-2026-0105',
      'PO-2026-0106',
    ]);
  });

  it('reports both Vasudha vendors for the shared PAN-less name (S17)', async () => {
    expect((await erp.findVendorsByNormalizedName('vasudha traders')).map((v) => v.code)).toEqual([
      'V005',
      'V006',
    ]);
    expect(await erp.findVendorByGstin(gstin('29AADCN9753P1ZH'))).toBeNull();
  });
});
