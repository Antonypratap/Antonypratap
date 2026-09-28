/**
 * Reusable ErpConnector contract suite. Every connector (FakeErpConnector in Phase 2, any real
 * ERP connector later) runs it from its own test file:
 *
 *   describeErpConnectorContract({ name: 'fake-erp', setup: async () => ({ connector, reopen, teardown }) });
 *
 * `setup` must return a connector over an ERP containing its company and no other records.
 * `reopen`, when provided, must return a new connector over the same durable storage; it is used
 * to prove that idempotency survives a restart (decision D4).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ErpIdSchema,
  InvoiceIdSchema,
  UserIdSchema,
  creationIdempotencyKey,
  importIdempotencyKey,
  normalizeInvoiceNumber,
  normalizeName,
  purchaseInvoiceIdempotencyKey,
  CreationActionIdSchema,
  type ErpId,
  type IdempotencyKey,
  type InvoiceId,
} from '@veyra/shared';
import { financialYearOf, validateGstin, type Gstin, type Pan } from '@veyra/india-tax';
import { ERP_CAPABILITIES, supportsOperation } from '../capabilities';
import { ERP_CONNECTION_STATUSES } from '../connection';
import type { ErpConnector } from '../connector';
import { isErpConnectorError, type ErpConnectorError } from '../errors';
import { describeConnection, guardCapabilities } from '../guard';
import { ERP_READ_OPERATIONS, ERP_WRITE_OPERATIONS } from '../operations';
import {
  CompanySchema,
  GrnSchema,
  ItemSchema,
  PurchaseInvoiceSchema,
  PurchaseOrderSchema,
  VendorItemAliasSchema,
  VendorSchema,
} from '../entities';
import type {
  ImportBusinessRecordsInput,
  CreateGrnInput,
  CreateItemInput,
  CreatePurchaseOrderInput,
  CreateVendorInput,
  RecordPurchaseInvoiceInput,
} from '../inputs';

export interface ErpConnectorContractSubject {
  connector: ErpConnector;
  reopen?: () => Promise<ErpConnector>;
  teardown?: () => Promise<void>;
}

export interface ErpConnectorContractOptions {
  name: string;
  setup: () => Promise<ErpConnectorContractSubject>;
}

// Deterministic ULIDs (digits are valid Crockford base32).
const ulid = (n: number): string => n.toString().padStart(26, '0');
const INVOICE: InvoiceId = InvoiceIdSchema.parse(ulid(1));
const OTHER_INVOICE: InvoiceId = InvoiceIdSchema.parse(ulid(2));
const USER = UserIdSchema.parse(ulid(9));
let actionCounter = 1000;
const newKey = (invoice: InvoiceId = INVOICE): IdempotencyKey =>
  creationIdempotencyKey(invoice, CreationActionIdSchema.parse(ulid(actionCounter++)));

// DEMO.md values: Nandi Stationers (not in the seed ERP) and scenario S03.
const NANDI_GSTIN = '29AADCN9753P1ZH';
const EASTLINE_GSTIN = '29AAKCE3344D1ZP';
const BAD_CHECKSUM_GSTIN = '29AAGCM4455J1Z5';
const gstin = (g: string): Gstin => {
  const r = validateGstin(g);
  if (!r.ok) throw new Error(`test GSTIN ${g} is invalid`);
  return r.value.gstin;
};
const panOf = (g: string): Pan => {
  const r = validateGstin(g);
  if (!r.ok) throw new Error(`test GSTIN ${g} is invalid`);
  return r.value.pan;
};

const vendorInput = (overrides: Partial<CreateVendorInput> = {}): CreateVendorInput => ({
  name: 'Nandi Stationers Pvt Ltd',
  gstin: NANDI_GSTIN,
  address: 'Bengaluru, Karnataka',
  sourceInvoiceId: INVOICE,
  ...overrides,
});

const itemInput = (overrides: Partial<CreateItemInput> = {}): CreateItemInput => ({
  name: 'A4 Copier Paper 75 GSM',
  hsnSac: '4802',
  uom: 'REAM',
  gstRateBp: 1200,
  sourceInvoiceId: INVOICE,
  approvedByUserId: USER,
  ...overrides,
});

const code = (error: unknown): unknown => (error as { code?: unknown }).code;

async function expectErpError(
  promise: Promise<unknown>,
  expected: string,
): Promise<ErpConnectorError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${expected}, but the call succeeded`);
    },
    (e: unknown) => e,
  );
  expect(code(error)).toBe(expected);
  // Every error a connector throws is typed and safe to show (Phase 4).
  if (!isErpConnectorError(error)) throw new Error('expected an ErpConnectorError');
  expect(error.userMessage).toMatch(/\S/);
  return error;
}

export function describeErpConnectorContract(options: ErpConnectorContractOptions): void {
  describe(`ErpConnector contract: ${options.name}`, () => {
    let subject: ErpConnectorContractSubject;
    let erp: ErpConnector;

    beforeEach(async () => {
      subject = await options.setup();
      erp = subject.connector;
    });
    afterEach(async () => {
      await subject.teardown?.();
    });

    /** Vendor + item + auto PO for 40 REAM @ ₹245.00, 12% (DEMO S03). */
    async function seedPoChain(): Promise<{
      vendorId: ErpId;
      itemId: ErpId;
      poId: ErpId;
      poLineId: ErpId;
    }> {
      const vendor = await erp.createVendor(vendorInput(), newKey());
      const item = await erp.createItem(itemInput(), newKey());
      const po = await erp.createPurchaseOrder(
        {
          vendorId: vendor.id,
          poDate: '2026-09-17',
          origin: 'auto_created_from_invoice',
          sourceInvoiceId: INVOICE,
          approvedByUserId: null,
          lines: [
            {
              lineNo: 1,
              itemId: item.id,
              qtyMilli: 40_000,
              unitPricePaise: 24_500,
              gstRateBp: 1200,
            },
          ],
        },
        newKey(),
      );
      const line = po.lines[0];
      if (!line) throw new Error('PO has no line');
      return { vendorId: vendor.id, itemId: item.id, poId: po.id, poLineId: line.id };
    }

    const grnInput = (
      poId: ErpId,
      poLineId: ErpId,
      over: Partial<CreateGrnInput> = {},
    ): CreateGrnInput => ({
      poId,
      grnDate: '2026-09-17',
      confirmedByUserId: USER,
      sourceInvoiceId: INVOICE,
      lines: [{ poLineId, receivedQtyMilli: 40_000, acceptedQtyMilli: 40_000 }],
      ...over,
    });

    const invoiceInput = (
      chain: { vendorId: ErpId; itemId: ErpId; poId: ErpId; poLineId: ErpId },
      over: Partial<RecordPurchaseInvoiceInput> = {},
    ): RecordPurchaseInvoiceInput => ({
      vendorId: chain.vendorId,
      vendorInvoiceNo: 'NS-0092',
      invoiceDate: '2026-09-17',
      poId: chain.poId,
      taxablePaise: 980_000,
      cgstPaise: 58_800,
      sgstPaise: 58_800,
      igstPaise: 0,
      roundOffPaise: null,
      totalPaise: 1_097_600,
      veyraInvoiceId: INVOICE,
      lines: [
        {
          lineNo: 1,
          poLineId: chain.poLineId,
          itemId: chain.itemId,
          qtyMilli: 40_000,
          unitPricePaise: 24_500,
          taxablePaise: 980_000,
          gstRateBp: 1200,
          cgstPaise: null,
          sgstPaise: null,
          igstPaise: null,
        },
      ],
      ...over,
    });

    describe('company and empty reads', () => {
      it('returns a schema-valid company', async () => {
        expect(CompanySchema.safeParse(await erp.getCompany()).success).toBe(true);
      });

      it('key lookups return null / [] when nothing matches', async () => {
        expect(await erp.findVendorByGstin(gstin(NANDI_GSTIN))).toBeNull();
        expect(await erp.findVendorsByPan(panOf(NANDI_GSTIN))).toEqual([]);
        expect(await erp.findVendorsByNormalizedName('nandi stationers')).toEqual([]);
        expect(await erp.getVendor(ErpIdSchema.parse('no-such-vendor'))).toBeNull();
        expect(await erp.getItem(ErpIdSchema.parse('no-such-item'))).toBeNull();
        expect(await erp.findItemsByHsn('9608')).toEqual([]);
        expect(await erp.getPurchaseOrderByNumber('PO-2026-0199')).toBeNull();
        expect(await erp.getPurchaseOrder(ErpIdSchema.parse('no-such-po'))).toBeNull();
      });

      it('parent-scoped operations reject unknown parents', async () => {
        const missing = ErpIdSchema.parse('no-such-id');
        await expectErpError(erp.listOpenPurchaseOrders(missing), 'NOT_FOUND');
        await expectErpError(erp.listGrnsForPo(missing), 'NOT_FOUND');
        await expectErpError(erp.getInvoicedQtyByPoLine(missing), 'NOT_FOUND');
      });

      it('exposes no payment operation', () => {
        const surface = erp as unknown as Record<string, unknown>;
        for (const name of [
          'pay',
          'payInvoice',
          'makePayment',
          'executePayment',
          'recordPayment',
        ]) {
          expect(surface[name]).toBeUndefined();
        }
      });
    });

    describe('vendors', () => {
      it('creates a vendor, deriving PAN, state and normalised name', async () => {
        const v = await erp.createVendor(vendorInput(), newKey());
        expect(VendorSchema.safeParse(v).success).toBe(true);
        expect(v).toMatchObject({
          gstin: NANDI_GSTIN,
          pan: NANDI_GSTIN.slice(2, 12),
          stateCode: '29',
          nameNormalized: normalizeName('Nandi Stationers Pvt Ltd'),
          status: 'active',
          origin: 'created_by_veyra',
          sourceInvoiceId: INVOICE,
        });
        expect((await erp.findVendorByGstin(gstin(NANDI_GSTIN)))?.id).toBe(v.id);
        expect((await erp.findVendorsByPan(panOf(NANDI_GSTIN))).map((x) => x.id)).toEqual([v.id]);
        expect((await erp.findVendorsByNormalizedName(v.nameNormalized)).map((x) => x.id)).toEqual([
          v.id,
        ]);
        expect((await erp.getVendor(v.id))?.id).toBe(v.id);
      });

      it('replaying the same key and payload returns the same vendor and creates nothing', async () => {
        const key = newKey();
        const first = await erp.createVendor(vendorInput(), key);
        const second = await erp.createVendor(vendorInput(), key);
        expect(second.id).toBe(first.id);
        expect(await erp.findVendorsByPan(panOf(NANDI_GSTIN))).toHaveLength(1);
      });

      it('replay survives a restart', async () => {
        if (!subject.reopen) return;
        const key = newKey();
        const first = await erp.createVendor(vendorInput(), key);
        const reopened = await subject.reopen();
        expect((await reopened.createVendor(vendorInput(), key)).id).toBe(first.id);
        expect(await reopened.findVendorsByPan(panOf(NANDI_GSTIN))).toHaveLength(1);
      });

      it('the same key with a different payload is refused and writes nothing', async () => {
        const key = newKey();
        await erp.createVendor(vendorInput(), key);
        const error = await expectErpError(
          erp.createVendor(vendorInput({ name: 'Eastline', gstin: EASTLINE_GSTIN }), key),
          'IDEMPOTENCY_CONFLICT',
        );
        expect((error as { reason?: unknown }).reason).toBe('payload_mismatch');
        expect(await erp.findVendorByGstin(gstin(EASTLINE_GSTIN))).toBeNull();
      });

      it('the same key for a different operation is refused', async () => {
        const key = newKey();
        await erp.createVendor(vendorInput(), key);
        const error = await expectErpError(
          erp.createItem(itemInput(), key),
          'IDEMPOTENCY_CONFLICT',
        );
        expect((error as { reason?: unknown }).reason).toBe('operation_mismatch');
        expect(await erp.findItemsByHsn('4802')).toEqual([]);
      });

      it('a GSTIN already created under another key is a conflict, never a silent match', async () => {
        const first = await erp.createVendor(vendorInput(), newKey());
        const error = await expectErpError(
          erp.createVendor(vendorInput(), newKey(OTHER_INVOICE)),
          'CONFLICT',
        );
        expect((error as { existingId?: unknown }).existingId).toBe(first.id);
      });

      it('invalid input is refused and does not consume the key', async () => {
        const key = newKey();
        await expectErpError(
          erp.createVendor(vendorInput({ gstin: BAD_CHECKSUM_GSTIN }), key),
          'VALIDATION',
        );
        expect(await erp.findVendorsByPan(panOf(NANDI_GSTIN))).toEqual([]);
        const created = await erp.createVendor(vendorInput(), key);
        expect(created.gstin).toBe(NANDI_GSTIN);
      });

      it('reactivating an active vendor changes nothing; unknown vendors are NOT_FOUND', async () => {
        const v = await erp.createVendor(vendorInput(), newKey());
        const input = { vendorId: v.id, sourceInvoiceId: INVOICE, approvedByUserId: USER };
        const key = newKey();
        expect(await erp.reactivateVendor(input, key)).toMatchObject({
          id: v.id,
          status: 'active',
        });
        expect((await erp.reactivateVendor(input, key)).id).toBe(v.id);
        await expectErpError(
          erp.reactivateVendor(
            { ...input, vendorId: ErpIdSchema.parse('no-such-vendor') },
            newKey(),
          ),
          'NOT_FOUND',
        );
      });
    });

    describe('items and aliases', () => {
      it('creates an item findable by HSN and by normalised name + HSN', async () => {
        const item = await erp.createItem(itemInput(), newKey());
        expect(ItemSchema.safeParse(item).success).toBe(true);
        expect(item).toMatchObject({
          hsnSac: '4802',
          uom: 'REAM',
          gstRateBp: 1200,
          origin: 'created_by_veyra',
        });
        expect((await erp.findItemsByHsn('4802')).map((i) => i.id)).toEqual([item.id]);
        expect(
          (
            await erp.findItemsByNormalizedNameAndHsn(
              normalizeName('A4 Copier Paper 75 GSM'),
              '4802',
            )
          ).map((i) => i.id),
        ).toEqual([item.id]);
        expect(
          await erp.findItemsByNormalizedNameAndHsn(
            normalizeName('A4 Copier Paper 75 GSM'),
            '4819',
          ),
        ).toEqual([]);
      });

      it('refuses an invalid HSN', async () => {
        await expectErpError(
          erp.createItem(itemInput({ hsnSac: '48021' }), newKey()),
          'VALIDATION',
        );
      });

      it('creates aliases with a (vendor, code) natural key', async () => {
        const v = await erp.createVendor(vendorInput(), newKey());
        const item = await erp.createItem(itemInput(), newKey());
        const aliasInput = {
          vendorId: v.id,
          vendorItemCode: 'NS-A4-75',
          itemId: item.id,
          sourceInvoiceId: INVOICE,
        };
        const alias = await erp.createVendorItemAlias(aliasInput, newKey());
        expect(VendorItemAliasSchema.safeParse(alias).success).toBe(true);
        expect((await erp.findItemByVendorAlias(v.id, 'NS-A4-75'))?.id).toBe(item.id);
        expect(await erp.findItemByVendorAlias(v.id, 'ns-a4-75')).toBeNull(); // exact match only
        await expectErpError(
          erp.createVendorItemAlias(aliasInput, newKey(OTHER_INVOICE)),
          'CONFLICT',
        );
        await expectErpError(
          erp.createVendorItemAlias(
            { ...aliasInput, vendorId: ErpIdSchema.parse('no-such-vendor') },
            newKey(),
          ),
          'NOT_FOUND',
        );
      });
    });

    describe('purchase orders', () => {
      it('stores an auto-created PO exactly as given, tagged, with an ERP-assigned number', async () => {
        const chain = await seedPoChain();
        const po = await erp.getPurchaseOrder(chain.poId);
        expect(po).not.toBeNull();
        expect(PurchaseOrderSchema.safeParse(po).success).toBe(true);
        expect(po).toMatchObject({
          vendorId: chain.vendorId,
          status: 'open',
          origin: 'auto_created_from_invoice',
          sourceInvoiceId: INVOICE,
          approvedByUserId: null,
        });
        expect(po?.lines).toEqual([
          expect.objectContaining({
            lineNo: 1,
            itemId: chain.itemId,
            qtyMilli: 40_000,
            unitPricePaise: 24_500,
            gstRateBp: 1200,
          }),
        ]);
        expect(po?.poNumber).not.toBe('');
        expect((await erp.getPurchaseOrderByNumber(po?.poNumber ?? ''))?.id).toBe(chain.poId);
        expect((await erp.listOpenPurchaseOrders(chain.vendorId)).map((p) => p.id)).toEqual([
          chain.poId,
        ]);
      });

      it('replaying a PO write returns the same PO and number', async () => {
        const v = await erp.createVendor(vendorInput(), newKey());
        const item = await erp.createItem(itemInput(), newKey());
        const input: CreatePurchaseOrderInput = {
          vendorId: v.id,
          poDate: '2026-09-18',
          origin: 'created_from_invoice_on_approval',
          sourceInvoiceId: INVOICE,
          approvedByUserId: USER,
          lines: [
            {
              lineNo: 1,
              itemId: item.id,
              qtyMilli: 12_000,
              unitPricePaise: 245_000,
              gstRateBp: 1800,
            },
          ],
        };
        const key = newKey();
        const first = await erp.createPurchaseOrder(input, key);
        const second = await erp.createPurchaseOrder(input, key);
        expect([second.id, second.poNumber]).toEqual([first.id, first.poNumber]);
        expect(await erp.listOpenPurchaseOrders(v.id)).toHaveLength(1);
      });

      it('requires an approver exactly for POs created on approval', async () => {
        const v = await erp.createVendor(vendorInput(), newKey());
        const item = await erp.createItem(itemInput(), newKey());
        const lines = [
          { lineNo: 1, itemId: item.id, qtyMilli: 1000, unitPricePaise: 100, gstRateBp: 1800 },
        ];
        const base = { vendorId: v.id, poDate: '2026-09-18', sourceInvoiceId: INVOICE, lines };
        await expectErpError(
          erp.createPurchaseOrder(
            { ...base, origin: 'created_from_invoice_on_approval', approvedByUserId: null },
            newKey(),
          ),
          'VALIDATION',
        );
        await expectErpError(
          erp.createPurchaseOrder(
            { ...base, origin: 'auto_created_from_invoice', approvedByUserId: USER },
            newKey(),
          ),
          'VALIDATION',
        );
        await expectErpError(
          erp.createPurchaseOrder(
            {
              ...base,
              origin: 'auto_created_from_invoice',
              approvedByUserId: null,
              vendorId: ErpIdSchema.parse('nope'),
            },
            newKey(),
          ),
          'NOT_FOUND',
        );
      });
    });

    describe('GRNs', () => {
      it('records a user-confirmed GRN, idempotently', async () => {
        const chain = await seedPoChain();
        const key = newKey();
        const grn = await erp.createGrn(grnInput(chain.poId, chain.poLineId), key);
        expect(GrnSchema.safeParse(grn).success).toBe(true);
        expect(grn).toMatchObject({
          origin: 'user_confirmed_via_veyra',
          confirmedByUserId: USER,
          sourceInvoiceId: INVOICE,
        });
        expect((await erp.createGrn(grnInput(chain.poId, chain.poLineId), key)).id).toBe(grn.id);
        expect((await erp.listGrnsForPo(chain.poId)).map((g) => g.id)).toEqual([grn.id]);
      });

      it('refuses accepted > received and unknown POs', async () => {
        const chain = await seedPoChain();
        await expectErpError(
          erp.createGrn(
            grnInput(chain.poId, chain.poLineId, {
              lines: [
                { poLineId: chain.poLineId, receivedQtyMilli: 40_000, acceptedQtyMilli: 40_001 },
              ],
            }),
            newKey(),
          ),
          'VALIDATION',
        );
        await expectErpError(
          erp.createGrn(grnInput(ErpIdSchema.parse('nope'), chain.poLineId), newKey()),
          'NOT_FOUND',
        );
        expect(await erp.listGrnsForPo(chain.poId)).toEqual([]);
      });
    });

    describe('browsing lists', () => {
      it('start empty apart from the company', async () => {
        expect(await erp.listVendors()).toEqual([]);
        expect(await erp.listItems()).toEqual([]);
        expect(await erp.listPurchaseOrders()).toEqual([]);
        expect(await erp.listGrns()).toEqual([]);
        expect(await erp.listPurchaseInvoices()).toEqual([]);
      });

      it('list every record written, schema-valid, and change nothing', async () => {
        const chain = await seedPoChain();
        await erp.recordPurchaseInvoice(
          invoiceInput(chain),
          purchaseInvoiceIdempotencyKey(INVOICE),
        );
        const vendors = await erp.listVendors();
        expect(vendors.map((v) => v.id)).toContain(chain.vendorId);
        expect(vendors.every((v) => VendorSchema.safeParse(v).success)).toBe(true);
        expect((await erp.listItems()).every((i) => ItemSchema.safeParse(i).success)).toBe(true);
        const pos = await erp.listPurchaseOrders();
        expect(pos.map((p) => p.id)).toEqual([chain.poId]);
        expect(pos.every((p) => PurchaseOrderSchema.safeParse(p).success)).toBe(true);
        expect((await erp.listGrns()).every((g) => GrnSchema.safeParse(g).success)).toBe(true);
        const invoices = await erp.listPurchaseInvoices();
        expect(invoices).toHaveLength(1);
        expect(PurchaseInvoiceSchema.safeParse(invoices[0]).success).toBe(true);
        expect(await erp.listPurchaseInvoices()).toEqual(invoices);
      });
    });

    describe('business record import', () => {
      const IMPORT = ulid(7001);
      const batch = (
        over: Partial<ImportBusinessRecordsInput> = {},
      ): ImportBusinessRecordsInput => ({
        importId: IMPORT,
        vendors: [
          {
            code: 'SUP-01',
            name: 'Nandi Stationers Pvt Ltd',
            gstin: NANDI_GSTIN,
            address: 'Bengaluru',
            status: 'active',
          },
        ],
        items: [
          {
            code: 'PAPER-A4',
            name: 'A4 Copier Paper 75 GSM',
            hsnSac: '4802',
            uom: 'REAM',
            gstRateBp: 1200,
          },
        ],
        purchaseOrders: [
          {
            poNumber: 'PO-IMP-1',
            vendorCode: 'SUP-01',
            poDate: '2026-09-01',
            status: 'open',
            lines: [
              {
                lineNo: 1,
                itemCode: 'PAPER-A4',
                qtyMilli: 40_000,
                unitPricePaise: 24_500,
                gstRateBp: 1200,
              },
            ],
          },
        ],
        grns: [
          {
            grnNumber: 'GRN-IMP-1',
            poNumber: 'PO-IMP-1',
            grnDate: '2026-09-02',
            lines: [{ poLineNo: 1, receivedQtyMilli: 40_000, acceptedQtyMilli: 38_000 }],
          },
        ],
        ...over,
      });

      it('imports vendors, items, POs and GRNs in one write, tagged as imported', async () => {
        const result = await erp.importBusinessRecords(batch(), importIdempotencyKey(IMPORT));
        expect(result).toEqual({
          importId: IMPORT,
          created: { vendors: 1, items: 1, purchaseOrders: 1, grns: 1 },
          skipped: { vendors: 0, items: 0, purchaseOrders: 0, grns: 0 },
        });
        const vendor = await erp.findVendorByGstin(gstin(NANDI_GSTIN));
        expect(vendor).toMatchObject({
          code: 'SUP-01',
          origin: 'imported',
          sourceImportId: IMPORT,
          sourceInvoiceId: null,
        });
        expect(VendorSchema.safeParse(vendor).success).toBe(true);
        const po = await erp.getPurchaseOrderByNumber('PO-IMP-1');
        expect(po).toMatchObject({ origin: 'imported', status: 'open', vendorId: vendor?.id });
        expect(PurchaseOrderSchema.safeParse(po).success).toBe(true);
        const [grn] = await erp.listGrnsForPo(po?.id as ErpId);
        expect(grn).toMatchObject({
          grnNumber: 'GRN-IMP-1',
          origin: 'imported',
          confirmedByUserId: null,
        });
        expect(grn?.lines[0]).toMatchObject({ receivedQtyMilli: 40_000, acceptedQtyMilli: 38_000 });
        expect(
          await erp.findItemsByNormalizedNameAndHsn(
            normalizeName('A4 Copier Paper 75 GSM'),
            '4802',
          ),
        ).toHaveLength(1);
      });

      it('replaying the key returns the same result; re-importing the same records skips them', async () => {
        const first = await erp.importBusinessRecords(batch(), importIdempotencyKey(IMPORT));
        expect(await erp.importBusinessRecords(batch(), importIdempotencyKey(IMPORT))).toEqual(
          first,
        );
        const again = ulid(7002);
        const second = await erp.importBusinessRecords(
          batch({ importId: again }),
          importIdempotencyKey(again),
        );
        expect(second.created).toEqual({ vendors: 0, items: 0, purchaseOrders: 0, grns: 0 });
        expect(second.skipped).toEqual({ vendors: 1, items: 1, purchaseOrders: 1, grns: 1 });
        expect(await erp.listVendors()).toHaveLength(1);
      });

      it('never changes an existing record: different values are a conflict and nothing is written', async () => {
        await erp.importBusinessRecords(batch(), importIdempotencyKey(IMPORT));
        const again = ulid(7003);
        const changed = batch({
          importId: again,
          vendors: [
            {
              code: 'SUP-01',
              name: 'Nandi Stationers (renamed)',
              gstin: NANDI_GSTIN,
              address: 'Bengaluru',
              status: 'active',
            },
            {
              code: 'SUP-02',
              name: 'Eastline Office Supplies Pvt Ltd',
              gstin: EASTLINE_GSTIN,
              address: 'Bengaluru',
              status: 'active',
            },
          ],
        });
        await expectErpError(
          erp.importBusinessRecords(changed, importIdempotencyKey(again)),
          'CONFLICT',
        );
        expect((await erp.listVendors()).map((v) => v.code)).toEqual(['SUP-01']);
        expect((await erp.findVendorByGstin(gstin(NANDI_GSTIN)))?.name).toBe(
          'Nandi Stationers Pvt Ltd',
        );
      });

      it('a missing reference fails the whole batch (no partial import)', async () => {
        const [po] = batch().purchaseOrders;
        if (!po) throw new Error('fixture');
        const bad = batch({ purchaseOrders: [{ ...po, vendorCode: 'NOPE' }] });
        await expectErpError(
          erp.importBusinessRecords(bad, importIdempotencyKey(IMPORT)),
          'NOT_FOUND',
        );
        expect(await erp.listVendors()).toEqual([]);
        expect(await erp.listItems()).toEqual([]);
        // The failed write did not consume the key.
        await erp.importBusinessRecords(batch(), importIdempotencyKey(IMPORT));
        expect(await erp.listPurchaseOrders()).toHaveLength(1);
      });

      it('refuses accepted > received and duplicate natural keys in one batch', async () => {
        const bad = batch({
          grns: [
            {
              grnNumber: 'GRN-IMP-1',
              poNumber: 'PO-IMP-1',
              grnDate: '2026-09-02',
              lines: [{ poLineNo: 1, receivedQtyMilli: 10, acceptedQtyMilli: 11 }],
            },
          ],
        });
        await expectErpError(
          erp.importBusinessRecords(bad, importIdempotencyKey(IMPORT)),
          'VALIDATION',
        );
        const [item] = batch().items;
        if (!item) throw new Error('fixture');
        const dup = batch({ items: [item, item] });
        await expectErpError(
          erp.importBusinessRecords(dup, importIdempotencyKey(IMPORT)),
          'VALIDATION',
        );
        expect(await erp.listVendors()).toEqual([]);
      });
    });

    describe('purchase invoices', () => {
      it('records an invoice as verified_pending_payment and counts invoiced quantity once', async () => {
        const chain = await seedPoChain();
        const key = purchaseInvoiceIdempotencyKey(INVOICE);
        const inv = await erp.recordPurchaseInvoice(invoiceInput(chain), key);
        expect(PurchaseInvoiceSchema.safeParse(inv).success).toBe(true);
        expect(inv).toMatchObject({
          status: 'verified_pending_payment',
          vendorInvoiceNoNormalized: normalizeInvoiceNumber('NS-0092'),
          fy: '2026-27',
          totalPaise: 1_097_600,
          idempotencyKey: key,
        });
        expect(await erp.getInvoicedQtyByPoLine(chain.poLineId)).toBe(40_000);

        const replay = await erp.recordPurchaseInvoice(invoiceInput(chain), key);
        expect(replay.id).toBe(inv.id);
        expect(await erp.getInvoicedQtyByPoLine(chain.poLineId)).toBe(40_000);

        const found = await erp.findPurchaseInvoice(
          chain.vendorId,
          normalizeInvoiceNumber('NS-0092'),
          financialYearOf(inv.invoiceDate),
        );
        expect(found?.id).toBe(inv.id);
      });

      it('a fully invoiced PO is no longer open', async () => {
        const chain = await seedPoChain();
        await erp.recordPurchaseInvoice(
          invoiceInput(chain),
          purchaseInvoiceIdempotencyKey(INVOICE),
        );
        expect(await erp.listOpenPurchaseOrders(chain.vendorId)).toEqual([]);
      });

      it('the same vendor + normalised number + FY under another key is a conflict', async () => {
        const chain = await seedPoChain();
        const first = await erp.recordPurchaseInvoice(
          invoiceInput(chain),
          purchaseInvoiceIdempotencyKey(INVOICE),
        );
        const error = await expectErpError(
          erp.recordPurchaseInvoice(
            invoiceInput(chain, { vendorInvoiceNo: 'ns - 0092', veyraInvoiceId: OTHER_INVOICE }),
            purchaseInvoiceIdempotencyKey(OTHER_INVOICE),
          ),
          'CONFLICT',
        );
        expect((error as { existingId?: unknown }).existingId).toBe(first.id);
        expect(await erp.getInvoicedQtyByPoLine(chain.poLineId)).toBe(40_000);
      });

      it('refuses arithmetically inconsistent invoices', async () => {
        const chain = await seedPoChain();
        await expectErpError(
          erp.recordPurchaseInvoice(
            invoiceInput(chain, { totalPaise: 1_097_601 }),
            purchaseInvoiceIdempotencyKey(INVOICE),
          ),
          'VALIDATION',
        );
        expect(await erp.getInvoicedQtyByPoLine(chain.poLineId)).toBe(0);
      });
    });

    // ── Phase 4: the boundary every connector must honour ──────────────────
    describe('boundary: capabilities, connection, errors, reconciliation', () => {
      it('reports its identity and a set of known capabilities', () => {
        expect(erp.info.type).toMatch(/\S/);
        expect(erp.info.displayName).toMatch(/\S/);
        const caps = erp.capabilities();
        expect(new Set(caps).size).toBe(caps.length);
        for (const c of caps) expect(ERP_CAPABILITIES).toContain(c);
      });

      it('checks its connection without throwing, and names the business when connected', async () => {
        const check = await erp.checkConnection();
        expect(ERP_CONNECTION_STATUSES).toContain(check.status);
        if (check.status === 'CONNECTED') expect(check.company?.name).toMatch(/\S/);
        const described = await describeConnection(erp);
        expect(described).toMatchObject({ type: erp.info.type, status: check.status });
        // Safe metadata only: no credentials, tokens, keys or hosts.
        expect(JSON.stringify(described)).not.toMatch(/password|secret|token|api[_-]?key|:\/\//i);
      });

      it('an operation outside its capabilities is UNSUPPORTED, before anything else happens', async () => {
        const caps = erp.capabilities();
        const missing = [...ERP_READ_OPERATIONS, ...ERP_WRITE_OPERATIONS].filter(
          (op) => !supportsOperation(caps, op),
        );
        for (const op of missing) {
          const call = (erp[op] as (...a: unknown[]) => Promise<unknown>).bind(erp);
          const error = await expectErpError(call({}, newKey()), 'UNSUPPORTED');
          expect(error.retryable).toBe(false);
        }
        // The guard enforces the same for any connector, whatever it would have done.
        const narrowed = guardCapabilities(
          Object.assign(Object.create(erp) as ErpConnector, {
            capabilities: () => caps.filter((c) => c !== 'purchase_invoice.create'),
          }),
        );
        await expectErpError(
          narrowed.recordPurchaseInvoice({} as RecordPurchaseInvoiceInput, newKey()),
          'UNSUPPORTED',
        );
      });

      it('errors are typed, with a safe message and a retryable flag', async () => {
        const error = await expectErpError(
          erp.createVendor(vendorInput({ gstin: BAD_CHECKSUM_GSTIN }), newKey()),
          'VALIDATION',
        );
        expect(error.retryable).toBe(false);
        expect(error.toSafeJSON()).toMatchObject({ code: 'VALIDATION', retryable: false });
        expect(error.userMessage).not.toMatch(/SQLITE|stack|at \//);
      });

      it('reconciles a write by its key: created (with the same record) or not created; never creates', async () => {
        if (!erp.capabilities().includes('write.reconcile')) return;
        const key = newKey();
        expect(await erp.reconcileWrite(key)).toEqual({ outcome: 'not_created' });
        expect(await erp.findVendorByGstin(gstin(NANDI_GSTIN))).toBeNull();
        const vendor = await erp.createVendor(vendorInput(), key);
        expect(await erp.reconcileWrite(key)).toEqual({
          outcome: 'created',
          operation: 'createVendor',
          recordId: vendor.id,
        });
        const invoiceKey = purchaseInvoiceIdempotencyKey(OTHER_INVOICE);
        expect(await erp.reconcileWrite(invoiceKey)).toEqual({ outcome: 'not_created' });
      });

      it('a repeated write never duplicates; the same key with other details is refused', async () => {
        const key = newKey();
        const a = await erp.createVendor(vendorInput(), key);
        const b = await erp.createVendor(vendorInput(), key);
        expect(b.id).toBe(a.id);
        expect((await erp.listVendors()).filter((v) => v.gstin === NANDI_GSTIN)).toHaveLength(1);
        await expectErpError(
          erp.createVendor(vendorInput({ name: 'Someone Else Pvt Ltd' }), key),
          'IDEMPOTENCY_CONFLICT',
        );
      });
    });
  });
}
