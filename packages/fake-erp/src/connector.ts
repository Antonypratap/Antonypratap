import type Database from 'better-sqlite3';
import { and, asc, count, desc, eq, like, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { z } from 'zod';
import {
  IdempotencyKeySchema,
  milliQty,
  normalizeInvoiceNumber,
  normalizeName,
  purchaseInvoiceIdempotencyKey,
  type ErpId,
  type IdempotencyKey,
  type MilliQty,
} from '@veyra/shared';
import {
  financialYearOf,
  validateGstin,
  type FinancialYear,
  type Gstin,
  type Pan,
} from '@veyra/india-tax';
import {
  CompanySchema,
  CreateGrnInputSchema,
  CreateItemInputSchema,
  CreatePurchaseOrderInputSchema,
  CreateVendorInputSchema,
  CreateVendorItemAliasInputSchema,
  ErpConflictError,
  ErpNotFoundError,
  ErpValidationError,
  GrnSchema,
  ItemSchema,
  PurchaseInvoiceSchema,
  PurchaseOrderSchema,
  ReactivateVendorInputSchema,
  RecordPurchaseInvoiceInputSchema,
  ImportBusinessRecordsInputSchema,
  type ImportBusinessRecordsInput,
  type ImportBusinessRecordsResult,
  type ImportCounts,
  VendorItemAliasSchema,
  VendorSchema,
  decideIdempotentWrite,
  payloadHash,
  ERP_CAPABILITIES,
  connectionStatusOf,
  type ErpCapability,
  type ErpConnectionCheck,
  type ErpWriteReconciliation,
  type Company,
  type CreateGrnInput,
  type CreateItemInput,
  type CreatePurchaseOrderInput,
  type CreateVendorInput,
  type CreateVendorItemAliasInput,
  type ErpConnector,
  type ErpConnectorInfo,
  type ErpOperation,
  type ErpWriteOperation,
  type Grn,
  type Item,
  type PurchaseInvoice,
  type PurchaseOrder,
  type ReactivateVendorInput,
  type RecordPurchaseInvoiceInput,
  type Vendor,
  type VendorItemAlias,
} from '@veyra/erp-connector';
import { openDatabase, type FakeErpDb } from './db/open';
import {
  company,
  grnLines,
  grns,
  idempotencyLog,
  items,
  poLines,
  purchaseInvoiceLines,
  purchaseInvoices,
  purchaseOrders,
  vendorItemAliases,
  vendors,
} from './db/schema';
import { mapError } from './errors';
import {
  grnId,
  grnLineId,
  itemId as itemIdOf,
  pad,
  poId as poIdOf,
  poLineId,
  purchaseInvoiceId,
  purchaseInvoiceLineId,
  vendorId as vendorIdOf,
} from './ids';
import { resetAndSeed, type FakeErpBusiness, type FakeErpSeed } from './seed/seed';

type Tx = Parameters<Parameters<FakeErpDb['transaction']>[0]>[0];
type Q = FakeErpDb | Tx;

/** Named points inside writes where tests can inject a crash (the transaction must roll back). */
export type FakeErpFailpoint =
  | 'write.executed'
  | 'purchase_order.header_inserted'
  | 'grn.header_inserted'
  | 'purchase_invoice.header_inserted'
  | 'purchase_invoice.line_inserted';

export interface FakeErpTestHooks {
  failpoint?: (name: FakeErpFailpoint) => void;
}

export interface FakeErpOptions {
  /** SQLite file path, or ':memory:'. */
  filename: string;
  /** If given, deterministically wipe and seed the database on open. */
  reset?: FakeErpSeed;
  /** Which sample business a reset writes (default `manufacturing`, the test suite's seed). */
  business?: FakeErpBusiness;
  /** Source of `createdAt` timestamps for new records. Defaults to the system clock. */
  clock?: () => Date;
  /** How long a write waits for another connection's lock before failing as UNAVAILABLE. */
  busyTimeoutMs?: number;
  /** Test-only fault injection. */
  testHooks?: FakeErpTestHooks;
}

const FAKE_ERP_CAPABILITIES: readonly ErpCapability[] = ERP_CAPABILITIES.filter(
  (c) => c !== 'vendor.one_time',
);

/**
 * ErpConnector over a local SQLite file (`fake_erp.db`). The database is private to this class:
 * no SQL, connection or table object is exposed. Business decisions (which PO, whether to create)
 * stay outside; this class stores, looks up and enforces referential and natural-key integrity.
 */
export class FakeErpConnector implements ErpConnector {
  readonly info: ErpConnectorInfo = {
    name: 'fake-erp',
    version: '1',
    type: 'fake-erp',
    displayName: 'Fake ERP',
  };

  readonly #sqlite: Database.Database;
  readonly #db: FakeErpDb;
  readonly #clock: () => Date;
  readonly #hooks: FakeErpTestHooks;
  readonly #business: FakeErpBusiness;

  private constructor(options: FakeErpOptions) {
    const { sqlite, db } = openDatabase(options.filename, {
      busyTimeoutMs: options.busyTimeoutMs ?? 5000,
    });
    this.#sqlite = sqlite;
    this.#db = db;
    this.#clock = options.clock ?? (() => new Date());
    this.#hooks = options.testHooks ?? {};
    this.#business = options.business ?? 'manufacturing';
    if (options.reset) resetAndSeed(this.#db, options.reset, this.#business);
  }

  static open(options: FakeErpOptions): FakeErpConnector {
    return new FakeErpConnector(options);
  }

  /** Deterministically wipe and re-seed (demo reset). */
  reset(seed: FakeErpSeed): void {
    resetAndSeed(this.#db, seed, this.#business);
  }

  close(): void {
    this.#sqlite.close();
  }

  /**
   * Sets the buying company (its name and GSTIN; the state follows the GSTIN). For a workspace
   * whose company is known only once its owner confirms it (the 5 Invoice Challenge).
   */
  setCompany(c: { name: string; gstin: string }): void {
    this.#db
      .update(company)
      .set({ name: c.name, gstin: c.gstin, stateCode: c.gstin.slice(0, 2) })
      .where(eq(company.id, 'company'))
      .run();
  }

  // ── Boundary (Phase 4) ───────────────────────────────────────────────────

  /** Everything except one-time suppliers, which this ERP has no concept of. */
  capabilities(): readonly ErpCapability[] {
    return FAKE_ERP_CAPABILITIES;
  }

  async checkConnection(): Promise<ErpConnectionCheck> {
    try {
      const c = await this.getCompany();
      return { status: 'CONNECTED', company: { name: c.name, identifier: c.gstin } };
    } catch (error) {
      return { status: connectionStatusOf(error), company: null };
    }
  }

  /** The idempotency log answers exactly: a key it holds was written; any other key was not. */
  async reconcileWrite(key: IdempotencyKey): Promise<ErpWriteReconciliation> {
    return this.#read('reconcileWrite', (q) => {
      const row = q.select().from(idempotencyLog).where(eq(idempotencyLog.key, key)).get();
      return row
        ? {
            outcome: 'created' as const,
            operation: row.operation as ErpWriteOperation,
            recordId: row.resultId as ErpId,
          }
        : { outcome: 'not_created' as const };
    });
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async getCompany(): Promise<Company> {
    return this.#read('getCompany', (q) => {
      const row = q.select().from(company).get();
      if (!row) throw new ErpNotFoundError('company', 'company');
      return CompanySchema.parse(row);
    });
  }

  async getVendor(id: ErpId): Promise<Vendor | null> {
    return this.#read('getVendor', (q) => loadVendor(q, id));
  }

  async findVendorByGstin(gstin: Gstin): Promise<Vendor | null> {
    return this.#read('findVendorByGstin', (q) => {
      const row = q.select().from(vendors).where(eq(vendors.gstin, gstin)).get();
      return row ? VendorSchema.parse(row) : null;
    });
  }

  async findVendorsByPan(pan: Pan): Promise<Vendor[]> {
    return this.#read('findVendorsByPan', (q) =>
      q
        .select()
        .from(vendors)
        .where(eq(vendors.pan, pan))
        .orderBy(asc(vendors.code))
        .all()
        .map((r) => VendorSchema.parse(r)),
    );
  }

  async findVendorsByNormalizedName(normalizedName: string): Promise<Vendor[]> {
    return this.#read('findVendorsByNormalizedName', (q) =>
      q
        .select()
        .from(vendors)
        .where(eq(vendors.nameNormalized, normalizedName))
        .orderBy(asc(vendors.code))
        .all()
        .map((r) => VendorSchema.parse(r)),
    );
  }

  async getItem(id: ErpId): Promise<Item | null> {
    return this.#read('getItem', (q) => loadItem(q, id));
  }

  async findItemByVendorAlias(vendorId: ErpId, vendorItemCode: string): Promise<Item | null> {
    return this.#read('findItemByVendorAlias', (q) => {
      const alias = q
        .select()
        .from(vendorItemAliases)
        .where(
          and(
            eq(vendorItemAliases.vendorId, vendorId),
            eq(vendorItemAliases.vendorItemCode, vendorItemCode),
          ),
        )
        .get();
      return alias ? loadItem(q, alias.itemId) : null;
    });
  }

  async findItemsByNormalizedNameAndHsn(normalizedName: string, hsnSac: string): Promise<Item[]> {
    return this.#read('findItemsByNormalizedNameAndHsn', (q) =>
      q
        .select()
        .from(items)
        .where(and(eq(items.nameNormalized, normalizedName), eq(items.hsnSac, hsnSac)))
        .orderBy(asc(items.code))
        .all()
        .map((r) => ItemSchema.parse(r)),
    );
  }

  async findItemsByHsn(hsnSac: string): Promise<Item[]> {
    return this.#read('findItemsByHsn', (q) =>
      q
        .select()
        .from(items)
        .where(eq(items.hsnSac, hsnSac))
        .orderBy(asc(items.code))
        .all()
        .map((r) => ItemSchema.parse(r)),
    );
  }

  async getPurchaseOrder(id: ErpId): Promise<PurchaseOrder | null> {
    return this.#read('getPurchaseOrder', (q) => loadPurchaseOrder(q, id));
  }

  async getPurchaseOrderByNumber(poNumber: string): Promise<PurchaseOrder | null> {
    return this.#read('getPurchaseOrderByNumber', (q) => {
      const row = q
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.poNumber, poNumber))
        .get();
      return row ? loadPurchaseOrder(q, row.id) : null;
    });
  }

  async listOpenPurchaseOrders(vendorId: ErpId): Promise<PurchaseOrder[]> {
    return this.#read('listOpenPurchaseOrders', (q) => {
      requireRow(
        q.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId)).get(),
        'vendor',
        vendorId,
      );
      const hasUninvoicedLine = sql`EXISTS (
        SELECT 1 FROM ${poLines} WHERE ${poLines.poId} = ${purchaseOrders.id}
          AND ${poLines.qtyMilli} > (
            SELECT coalesce(sum(${purchaseInvoiceLines.qtyMilli}), 0) FROM ${purchaseInvoiceLines}
            WHERE ${purchaseInvoiceLines.poLineId} = ${poLines.id}))`;
      return q
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.vendorId, vendorId),
            eq(purchaseOrders.status, 'open'),
            hasUninvoicedLine,
          ),
        )
        .orderBy(asc(purchaseOrders.poNumber))
        .all()
        .map((r) => mustLoad(loadPurchaseOrder(q, r.id)));
    });
  }

  async listGrnsForPo(poId: ErpId): Promise<Grn[]> {
    return this.#read('listGrnsForPo', (q) => {
      requireRow(
        q
          .select({ id: purchaseOrders.id })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, poId))
          .get(),
        'purchase_order',
        poId,
      );
      return q
        .select({ id: grns.id })
        .from(grns)
        .where(eq(grns.poId, poId))
        .orderBy(asc(grns.grnNumber))
        .all()
        .map((r) => mustLoad(loadGrn(q, r.id)));
    });
  }

  async getInvoicedQtyByPoLine(id: ErpId): Promise<MilliQty> {
    return this.#read('getInvoicedQtyByPoLine', (q) => {
      requireRow(
        q.select({ id: poLines.id }).from(poLines).where(eq(poLines.id, id)).get(),
        'po_line',
        id,
      );
      return invoicedQty(q, id);
    });
  }

  async findPurchaseInvoice(
    vendorId: ErpId,
    normalizedInvoiceNo: string,
    fy: FinancialYear,
  ): Promise<PurchaseInvoice | null> {
    return this.#read('findPurchaseInvoice', (q) => {
      const row = q
        .select({ id: purchaseInvoices.id })
        .from(purchaseInvoices)
        .where(
          and(
            eq(purchaseInvoices.vendorId, vendorId),
            eq(purchaseInvoices.vendorInvoiceNoNormalized, normalizedInvoiceNo),
            eq(purchaseInvoices.fy, fy),
          ),
        )
        .get();
      return row ? loadPurchaseInvoice(q, row.id) : null;
    });
  }

  // ── Browsing ─────────────────────────────────────────────────────────────

  async listVendors(): Promise<Vendor[]> {
    return this.#read('listVendors', (q) =>
      q
        .select()
        .from(vendors)
        .orderBy(asc(vendors.code))
        .all()
        .map((r) => VendorSchema.parse(r)),
    );
  }

  async listItems(): Promise<Item[]> {
    return this.#read('listItems', (q) =>
      q
        .select()
        .from(items)
        .orderBy(asc(items.code))
        .all()
        .map((r) => ItemSchema.parse(r)),
    );
  }

  async listPurchaseOrders(): Promise<PurchaseOrder[]> {
    return this.#read('listPurchaseOrders', (q) =>
      q
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .orderBy(asc(purchaseOrders.poNumber))
        .all()
        .map((r) => mustLoad(loadPurchaseOrder(q, r.id))),
    );
  }

  async listGrns(): Promise<Grn[]> {
    return this.#read('listGrns', (q) =>
      q
        .select({ id: grns.id })
        .from(grns)
        .orderBy(asc(grns.grnNumber))
        .all()
        .map((r) => mustLoad(loadGrn(q, r.id))),
    );
  }

  async listPurchaseInvoices(): Promise<PurchaseInvoice[]> {
    return this.#read('listPurchaseInvoices', (q) =>
      q
        .select({ id: purchaseInvoices.id })
        .from(purchaseInvoices)
        .orderBy(desc(purchaseInvoices.createdAt), desc(purchaseInvoices.id))
        .all()
        .map((r) => mustLoad(loadPurchaseInvoice(q, r.id))),
    );
  }

  // ── Writes (all idempotent) ──────────────────────────────────────────────

  async reactivateVendor(input: ReactivateVendorInput, key: IdempotencyKey): Promise<Vendor> {
    return this.#write(
      'reactivateVendor',
      ReactivateVendorInputSchema,
      input,
      key,
      (tx, v) => {
        requireRow(
          tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, v.vendorId)).get(),
          'vendor',
          v.vendorId,
        );
        tx.update(vendors).set({ status: 'active' }).where(eq(vendors.id, v.vendorId)).run();
        return v.vendorId;
      },
      (q, id) => mustLoad(loadVendor(q, id)),
    );
  }

  async createVendor(input: CreateVendorInput, key: IdempotencyKey): Promise<Vendor> {
    return this.#write(
      'createVendor',
      CreateVendorInputSchema,
      input,
      key,
      (tx, v, now) => {
        const existing = tx
          .select({ id: vendors.id })
          .from(vendors)
          .where(eq(vendors.gstin, v.gstin))
          .get();
        if (existing)
          throw new ErpConflictError('vendor', { gstin: v.gstin }, existing.id as ErpId);
        const parsed = validateGstin(v.gstin);
        if (!parsed.ok)
          throw new ErpValidationError('createVendor', [
            { path: 'gstin', message: parsed.error.message },
          ]);
        const code = nextCode(tx, vendors, vendors.code, 'V', 3);
        tx.insert(vendors)
          .values({
            id: code,
            code,
            name: v.name,
            nameNormalized: normalizeName(v.name),
            gstin: v.gstin,
            pan: parsed.value.pan,
            stateCode: parsed.value.stateCode,
            address: v.address,
            status: 'active',
            origin: 'created_by_veyra',
            sourceInvoiceId: v.sourceInvoiceId,
            createdAt: now,
          })
          .run();
        return code;
      },
      (q, id) => mustLoad(loadVendor(q, id)),
    );
  }

  async createItem(input: CreateItemInput, key: IdempotencyKey): Promise<Item> {
    return this.#write(
      'createItem',
      CreateItemInputSchema,
      input,
      key,
      (tx, v, now) => {
        const code = nextCode(tx, items, items.code, 'ITM-', 3);
        tx.insert(items)
          .values({
            id: code,
            code,
            name: v.name,
            nameNormalized: normalizeName(v.name),
            hsnSac: v.hsnSac,
            uom: v.uom,
            gstRateBp: v.gstRateBp,
            origin: 'created_by_veyra',
            sourceInvoiceId: v.sourceInvoiceId,
            createdAt: now,
          })
          .run();
        return code;
      },
      (q, id) => mustLoad(loadItem(q, id)),
    );
  }

  async createVendorItemAlias(
    input: CreateVendorItemAliasInput,
    key: IdempotencyKey,
  ): Promise<VendorItemAlias> {
    return this.#write(
      'createVendorItemAlias',
      CreateVendorItemAliasInputSchema,
      input,
      key,
      (tx, v, now) => {
        requireRow(
          tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, v.vendorId)).get(),
          'vendor',
          v.vendorId,
        );
        requireRow(
          tx.select({ id: items.id }).from(items).where(eq(items.id, v.itemId)).get(),
          'item',
          v.itemId,
        );
        const existing = tx
          .select({ id: vendorItemAliases.id })
          .from(vendorItemAliases)
          .where(
            and(
              eq(vendorItemAliases.vendorId, v.vendorId),
              eq(vendorItemAliases.vendorItemCode, v.vendorItemCode),
            ),
          )
          .get();
        if (existing) {
          throw new ErpConflictError(
            'vendor_item_alias',
            { vendorId: v.vendorId, vendorItemCode: v.vendorItemCode },
            existing.id as ErpId,
          );
        }
        const id = nextCode(tx, vendorItemAliases, vendorItemAliases.id, 'ALIAS-', 4);
        tx.insert(vendorItemAliases)
          .values({
            id,
            vendorId: v.vendorId,
            vendorItemCode: v.vendorItemCode,
            itemId: v.itemId,
            origin: 'created_by_veyra',
            sourceInvoiceId: v.sourceInvoiceId,
            createdAt: now,
          })
          .run();
        return id;
      },
      (q, id) => mustLoad(loadAlias(q, id)),
    );
  }

  async createPurchaseOrder(
    input: CreatePurchaseOrderInput,
    key: IdempotencyKey,
  ): Promise<PurchaseOrder> {
    return this.#write(
      'createPurchaseOrder',
      CreatePurchaseOrderInputSchema,
      input,
      key,
      (tx, v, now) => {
        requireRow(
          tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, v.vendorId)).get(),
          'vendor',
          v.vendorId,
        );
        for (const line of v.lines) {
          requireRow(
            tx.select({ id: items.id }).from(items).where(eq(items.id, line.itemId)).get(),
            'item',
            line.itemId,
          );
        }
        const poNumber = nextNumber(
          tx,
          purchaseOrders,
          purchaseOrders.poNumber,
          `AUTO/${financialYearOf(v.poDate)}/`,
        );
        tx.insert(purchaseOrders)
          .values({
            id: poNumber,
            poNumber,
            vendorId: v.vendorId,
            poDate: v.poDate,
            status: 'open',
            origin: v.origin,
            sourceInvoiceId: v.sourceInvoiceId,
            approvedByUserId: v.approvedByUserId,
            createdAt: now,
          })
          .run();
        this.#failpoint('purchase_order.header_inserted');
        for (const line of v.lines) {
          tx.insert(poLines)
            .values({
              id: poLineId(poNumber, line.lineNo),
              poId: poNumber,
              lineNo: line.lineNo,
              itemId: line.itemId,
              qtyMilli: line.qtyMilli,
              unitPricePaise: line.unitPricePaise,
              gstRateBp: line.gstRateBp,
            })
            .run();
        }
        return poNumber;
      },
      (q, id) => mustLoad(loadPurchaseOrder(q, id)),
    );
  }

  async createGrn(input: CreateGrnInput, key: IdempotencyKey): Promise<Grn> {
    return this.#write(
      'createGrn',
      CreateGrnInputSchema,
      input,
      key,
      (tx, v, now) => {
        requireRow(
          tx
            .select({ id: purchaseOrders.id })
            .from(purchaseOrders)
            .where(eq(purchaseOrders.id, v.poId))
            .get(),
          'purchase_order',
          v.poId,
        );
        requirePoLinesOfPo(
          tx,
          'createGrn',
          v.poId,
          v.lines.map((l) => l.poLineId),
        );
        const number = nextNumber(tx, grns, grns.grnNumber, `GRN/${financialYearOf(v.grnDate)}/`);
        const id = grnId(number);
        tx.insert(grns)
          .values({
            id,
            grnNumber: number,
            poId: v.poId,
            grnDate: v.grnDate,
            origin: 'user_confirmed_via_veyra',
            confirmedByUserId: v.confirmedByUserId,
            sourceInvoiceId: v.sourceInvoiceId,
            createdAt: now,
          })
          .run();
        this.#failpoint('grn.header_inserted');
        v.lines.forEach((line, i) => {
          tx.insert(grnLines)
            .values({
              id: grnLineId(id, i + 1),
              grnId: id,
              poLineId: line.poLineId,
              receivedQtyMilli: line.receivedQtyMilli,
              acceptedQtyMilli: line.acceptedQtyMilli,
            })
            .run();
        });
        return id;
      },
      (q, id) => mustLoad(loadGrn(q, id)),
    );
  }

  async recordPurchaseInvoice(
    input: RecordPurchaseInvoiceInput,
    key: IdempotencyKey,
  ): Promise<PurchaseInvoice> {
    return this.#write(
      'recordPurchaseInvoice',
      RecordPurchaseInvoiceInputSchema,
      input,
      key,
      (tx, v, now) => {
        if (key !== purchaseInvoiceIdempotencyKey(v.veyraInvoiceId)) {
          throw new ErpValidationError('recordPurchaseInvoice', [
            { path: 'key', message: 'key must be veyra:<veyraInvoiceId>:purchase_invoice' },
          ]);
        }
        requireRow(
          tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, v.vendorId)).get(),
          'vendor',
          v.vendorId,
        );
        requireRow(
          tx
            .select({ id: purchaseOrders.id })
            .from(purchaseOrders)
            .where(eq(purchaseOrders.id, v.poId))
            .get(),
          'purchase_order',
          v.poId,
        );
        requirePoLinesOfPo(
          tx,
          'recordPurchaseInvoice',
          v.poId,
          v.lines.map((l) => l.poLineId),
        );
        for (const line of v.lines) {
          requireRow(
            tx.select({ id: items.id }).from(items).where(eq(items.id, line.itemId)).get(),
            'item',
            line.itemId,
          );
        }
        const normalized = normalizeInvoiceNumber(v.vendorInvoiceNo);
        const fy = financialYearOf(v.invoiceDate);
        const existing = tx
          .select({ id: purchaseInvoices.id })
          .from(purchaseInvoices)
          .where(
            and(
              eq(purchaseInvoices.vendorId, v.vendorId),
              eq(purchaseInvoices.vendorInvoiceNoNormalized, normalized),
              eq(purchaseInvoices.fy, fy),
            ),
          )
          .get();
        if (existing) {
          throw new ErpConflictError(
            'purchase_invoice',
            { vendorId: v.vendorId, vendorInvoiceNoNormalized: normalized, fy },
            existing.id as ErpId,
          );
        }
        const id = purchaseInvoiceId(
          nextNumber(tx, purchaseInvoices, purchaseInvoices.id, `PINV/${fy}/`),
        );
        tx.insert(purchaseInvoices)
          .values({
            id,
            vendorId: v.vendorId,
            vendorInvoiceNo: v.vendorInvoiceNo,
            vendorInvoiceNoNormalized: normalized,
            invoiceDate: v.invoiceDate,
            fy,
            poId: v.poId,
            taxablePaise: v.taxablePaise,
            cgstPaise: v.cgstPaise,
            sgstPaise: v.sgstPaise,
            igstPaise: v.igstPaise,
            roundOffPaise: v.roundOffPaise,
            totalPaise: v.totalPaise,
            status: 'verified_pending_payment',
            veyraInvoiceId: v.veyraInvoiceId,
            idempotencyKey: key,
            createdAt: now,
          })
          .run();
        this.#failpoint('purchase_invoice.header_inserted');
        for (const line of v.lines) {
          tx.insert(purchaseInvoiceLines)
            .values({
              id: purchaseInvoiceLineId(id, line.lineNo),
              purchaseInvoiceId: id,
              lineNo: line.lineNo,
              poLineId: line.poLineId,
              itemId: line.itemId,
              qtyMilli: line.qtyMilli,
              unitPricePaise: line.unitPricePaise,
              taxablePaise: line.taxablePaise,
              gstRateBp: line.gstRateBp,
              cgstPaise: line.cgstPaise,
              sgstPaise: line.sgstPaise,
              igstPaise: line.igstPaise,
            })
            .run();
          this.#failpoint('purchase_invoice.line_inserted');
        }
        return id;
      },
      (q, id) => mustLoad(loadPurchaseInvoice(q, id)),
    );
  }

  // ── Import ───────────────────────────────────────────────────────────────

  /**
   * Imports the business's own records in one transaction, in dependency order (vendors, items,
   * POs, GRNs). Identical existing records are skipped; different ones are a CONFLICT; missing
   * references are NOT_FOUND. Nothing already in the ERP is ever changed.
   */
  async importBusinessRecords(
    input: ImportBusinessRecordsInput,
    key: IdempotencyKey,
  ): Promise<ImportBusinessRecordsResult> {
    const parsed = ImportBusinessRecordsInputSchema.safeParse(input);
    const sizes: ImportCounts = parsed.success
      ? {
          vendors: parsed.data.vendors.length,
          items: parsed.data.items.length,
          purchaseOrders: parsed.data.purchaseOrders.length,
          grns: parsed.data.grns.length,
        }
      : { vendors: 0, items: 0, purchaseOrders: 0, grns: 0 };
    return this.#write(
      'importBusinessRecords',
      ImportBusinessRecordsInputSchema,
      input,
      key,
      (tx, b, now) => {
        const imported = {
          origin: 'imported' as const,
          sourceImportId: b.importId,
          createdAt: now,
        };
        const conflict = (
          entity: ConstructorParameters<typeof ErpConflictError>[0],
          naturalKey: Record<string, string>,
          id: string,
        ) => new ErpConflictError(entity, naturalKey, id as ErpId);

        for (const v of b.vendors) {
          const parsedGstin = validateGstin(v.gstin);
          if (!parsedGstin.ok)
            throw new ErpValidationError('importBusinessRecords', [
              { path: `vendors.${v.code}.gstin`, message: parsedGstin.error.message },
            ]);
          const byCode = tx.select().from(vendors).where(eq(vendors.code, v.code)).get();
          if (byCode) {
            const same =
              byCode.name === v.name &&
              byCode.gstin === v.gstin &&
              byCode.address === v.address &&
              byCode.status === v.status;
            if (!same) throw conflict('vendor', { code: v.code }, byCode.id);
            continue;
          }
          const byGstin = tx
            .select({ id: vendors.id })
            .from(vendors)
            .where(eq(vendors.gstin, v.gstin))
            .get();
          if (byGstin) throw conflict('vendor', { gstin: v.gstin }, byGstin.id);
          tx.insert(vendors)
            .values({
              id: vendorIdOf(v.code),
              code: v.code,
              name: v.name,
              nameNormalized: normalizeName(v.name),
              gstin: v.gstin,
              pan: parsedGstin.value.pan,
              stateCode: parsedGstin.value.stateCode,
              address: v.address,
              status: v.status,
              sourceInvoiceId: null,
              ...imported,
            })
            .run();
        }

        for (const i of b.items) {
          const existing = tx.select().from(items).where(eq(items.code, i.code)).get();
          if (existing) {
            const same =
              existing.name === i.name &&
              existing.hsnSac === i.hsnSac &&
              existing.uom === i.uom &&
              existing.gstRateBp === i.gstRateBp;
            if (!same) throw conflict('item', { code: i.code }, existing.id);
            continue;
          }
          tx.insert(items)
            .values({
              id: itemIdOf(i.code),
              code: i.code,
              name: i.name,
              nameNormalized: normalizeName(i.name),
              hsnSac: i.hsnSac,
              uom: i.uom,
              gstRateBp: i.gstRateBp,
              sourceInvoiceId: null,
              ...imported,
            })
            .run();
        }

        const vendorByCode = (c: string) =>
          requireRow(
            tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.code, c)).get(),
            'vendor',
            c,
          ).id;
        const itemByCode = (c: string) =>
          requireRow(
            tx.select({ id: items.id }).from(items).where(eq(items.code, c)).get(),
            'item',
            c,
          ).id;

        for (const po of b.purchaseOrders) {
          const vendorId = vendorByCode(po.vendorCode);
          const lines = po.lines.map((l) => ({ ...l, itemId: itemByCode(l.itemCode) }));
          const existing = loadPurchaseOrderByNumber(tx, po.poNumber);
          if (existing) {
            const same =
              existing.vendorId === vendorId &&
              existing.poDate === po.poDate &&
              existing.status === po.status &&
              existing.lines.length === lines.length &&
              existing.lines.every((el, k) => {
                const l = lines[k];
                return (
                  l !== undefined &&
                  el.lineNo === l.lineNo &&
                  el.itemId === l.itemId &&
                  el.qtyMilli === l.qtyMilli &&
                  el.unitPricePaise === l.unitPricePaise &&
                  el.gstRateBp === l.gstRateBp
                );
              });
            if (!same) throw conflict('purchase_order', { poNumber: po.poNumber }, existing.id);
            continue;
          }
          const id = poIdOf(po.poNumber);
          tx.insert(purchaseOrders)
            .values({
              id,
              poNumber: po.poNumber,
              vendorId,
              poDate: po.poDate,
              status: po.status,
              sourceInvoiceId: null,
              approvedByUserId: null,
              ...imported,
            })
            .run();
          this.#failpoint('purchase_order.header_inserted');
          for (const l of lines) {
            tx.insert(poLines)
              .values({
                id: poLineId(id, l.lineNo),
                poId: id,
                lineNo: l.lineNo,
                itemId: l.itemId,
                qtyMilli: l.qtyMilli,
                unitPricePaise: l.unitPricePaise,
                gstRateBp: l.gstRateBp,
              })
              .run();
          }
        }

        for (const g of b.grns) {
          const po = loadPurchaseOrderByNumber(tx, g.poNumber);
          if (!po) throw new ErpNotFoundError('purchase_order', g.poNumber);
          const lines = g.lines.map((l) => {
            const pl = po.lines.find((x) => x.lineNo === l.poLineNo);
            if (!pl) throw new ErpNotFoundError('po_line', `${g.poNumber} line ${l.poLineNo}`);
            return { ...l, poLineId: pl.id };
          });
          const existingRow = tx
            .select({ id: grns.id })
            .from(grns)
            .where(eq(grns.grnNumber, g.grnNumber))
            .get();
          if (existingRow) {
            const existing = mustLoad(loadGrn(tx, existingRow.id));
            const same =
              existing.poId === po.id &&
              existing.grnDate === g.grnDate &&
              existing.lines.length === lines.length &&
              existing.lines.every((el, k) => {
                const l = lines[k];
                return (
                  l !== undefined &&
                  el.poLineId === l.poLineId &&
                  el.receivedQtyMilli === l.receivedQtyMilli &&
                  el.acceptedQtyMilli === l.acceptedQtyMilli
                );
              });
            if (!same) throw conflict('grn', { grnNumber: g.grnNumber }, existingRow.id);
            continue;
          }
          const id = grnId(g.grnNumber);
          tx.insert(grns)
            .values({
              id,
              grnNumber: g.grnNumber,
              poId: po.id,
              grnDate: g.grnDate,
              confirmedByUserId: null,
              sourceInvoiceId: null,
              ...imported,
            })
            .run();
          this.#failpoint('grn.header_inserted');
          lines.forEach((l, k) => {
            tx.insert(grnLines)
              .values({
                id: grnLineId(id, k + 1),
                grnId: id,
                poLineId: l.poLineId,
                receivedQtyMilli: l.receivedQtyMilli,
                acceptedQtyMilli: l.acceptedQtyMilli,
              })
              .run();
          });
        }
        return b.importId;
      },
      (q, importId) => {
        const created: ImportCounts = {
          vendors:
            q.select({ n: count() }).from(vendors).where(eq(vendors.sourceImportId, importId)).get()
              ?.n ?? 0,
          items:
            q.select({ n: count() }).from(items).where(eq(items.sourceImportId, importId)).get()
              ?.n ?? 0,
          purchaseOrders:
            q
              .select({ n: count() })
              .from(purchaseOrders)
              .where(eq(purchaseOrders.sourceImportId, importId))
              .get()?.n ?? 0,
          grns:
            q.select({ n: count() }).from(grns).where(eq(grns.sourceImportId, importId)).get()?.n ??
            0,
        };
        return {
          importId,
          created,
          skipped: {
            vendors: sizes.vendors - created.vendors,
            items: sizes.items - created.items,
            purchaseOrders: sizes.purchaseOrders - created.purchaseOrders,
            grns: sizes.grns - created.grns,
          },
        };
      },
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #failpoint(name: FakeErpFailpoint): void {
    this.#hooks.failpoint?.(name);
  }

  async #read<T>(operation: ErpOperation, fn: (q: Q) => T): Promise<T> {
    try {
      return fn(this.#db);
    } catch (error) {
      throw mapError(operation, error);
    }
  }

  /**
   * The idempotency contract (erp-connector/idempotency.ts): validate, then in one IMMEDIATE
   * transaction look up the key, replay / refuse / execute, and record the key with the write.
   * Any error rolls the whole transaction back, so a failed write leaves no rows and no key.
   */
  async #write<S extends z.ZodType, T>(
    operation: ErpWriteOperation,
    schema: S,
    input: unknown,
    key: unknown,
    execute: (tx: Tx, value: z.output<S>, now: string) => string,
    load: (q: Q, id: string) => T,
  ): Promise<T> {
    try {
      const parsedKey = IdempotencyKeySchema.safeParse(key);
      if (!parsedKey.success)
        throw new ErpValidationError(operation, [
          { path: 'key', message: 'invalid idempotency key' },
        ]);
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw ErpValidationError.fromZod(operation, parsed.error);
      const value = parsed.data as z.output<S>;
      const hash = payloadHash(value);
      return this.#db.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(idempotencyLog)
            .where(eq(idempotencyLog.key, parsedKey.data))
            .get();
          const decision = decideIdempotentWrite(
            row
              ? {
                  key: parsedKey.data,
                  operation: row.operation as ErpWriteOperation,
                  payloadHash: row.payloadHash,
                  resultId: row.resultId as ErpId,
                }
              : null,
            { key: parsedKey.data, operation, payloadHash: hash },
          );
          if (decision.kind === 'conflict') throw decision.error;
          if (decision.kind === 'replay') return load(tx, decision.resultId);
          const now = this.#clock().toISOString();
          const resultId = execute(tx, value, now);
          tx.insert(idempotencyLog)
            .values({ key: parsedKey.data, operation, payloadHash: hash, resultId, createdAt: now })
            .run();
          this.#failpoint('write.executed');
          return load(tx, resultId);
        },
        { behavior: 'immediate' },
      );
    } catch (error) {
      throw mapError(operation, error);
    }
  }
}

// ── Row loading ────────────────────────────────────────────────────────────

function requireRow<T>(
  row: T | undefined,
  entity: ConstructorParameters<typeof ErpNotFoundError>[0],
  id: string,
): T {
  if (row === undefined) throw new ErpNotFoundError(entity, id);
  return row;
}

function mustLoad<T>(value: T | null): T {
  if (value === null) throw new Error('fake-erp: record vanished inside its own transaction');
  return value;
}

/** Every PO line referenced must exist (NOT_FOUND) and belong to the given PO (VALIDATION). */
function requirePoLinesOfPo(
  q: Q,
  operation: ErpOperation,
  poId: string,
  lineIds: readonly string[],
): void {
  lineIds.forEach((lineId, i) => {
    const line = requireRow(
      q.select({ poId: poLines.poId }).from(poLines).where(eq(poLines.id, lineId)).get(),
      'po_line',
      lineId,
    );
    if (line.poId !== poId) {
      throw new ErpValidationError(operation, [
        { path: `lines.${i}.poLineId`, message: `PO line ${lineId} does not belong to ${poId}` },
      ]);
    }
  });
}

function loadVendor(q: Q, id: string): Vendor | null {
  const row = q.select().from(vendors).where(eq(vendors.id, id)).get();
  return row ? VendorSchema.parse(row) : null;
}

function loadItem(q: Q, id: string): Item | null {
  const row = q.select().from(items).where(eq(items.id, id)).get();
  return row ? ItemSchema.parse(row) : null;
}

function loadAlias(q: Q, id: string): VendorItemAlias | null {
  const row = q.select().from(vendorItemAliases).where(eq(vendorItemAliases.id, id)).get();
  return row ? VendorItemAliasSchema.parse(row) : null;
}

function loadPurchaseOrder(q: Q, id: string): PurchaseOrder | null {
  const row = q.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).get();
  if (!row) return null;
  const lines = q
    .select()
    .from(poLines)
    .where(eq(poLines.poId, id))
    .orderBy(asc(poLines.lineNo))
    .all();
  return PurchaseOrderSchema.parse({ ...row, lines });
}

function loadPurchaseOrderByNumber(q: Q, poNumber: string): PurchaseOrder | null {
  const row = q
    .select({ id: purchaseOrders.id })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.poNumber, poNumber))
    .get();
  return row ? loadPurchaseOrder(q, row.id) : null;
}

function loadGrn(q: Q, id: string): Grn | null {
  const row = q.select().from(grns).where(eq(grns.id, id)).get();
  if (!row) return null;
  const lines = q
    .select()
    .from(grnLines)
    .where(eq(grnLines.grnId, id))
    .orderBy(sql`rowid`)
    .all();
  return GrnSchema.parse({ ...row, lines });
}

function loadPurchaseInvoice(q: Q, id: string): PurchaseInvoice | null {
  const row = q.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, id)).get();
  if (!row) return null;
  const lines = q
    .select()
    .from(purchaseInvoiceLines)
    .where(eq(purchaseInvoiceLines.purchaseInvoiceId, id))
    .orderBy(asc(purchaseInvoiceLines.lineNo))
    .all();
  return PurchaseInvoiceSchema.parse({ ...row, lines });
}

function invoicedQty(q: Q, lineId: string): MilliQty {
  const row = q
    .select({ total: sql<number>`coalesce(sum(${purchaseInvoiceLines.qtyMilli}), 0)` })
    .from(purchaseInvoiceLines)
    .where(eq(purchaseInvoiceLines.poLineId, lineId))
    .get();
  return milliQty(row?.total ?? 0);
}

// ── Numbering (deterministic; runs inside the write transaction) ───────────

type NumberedTable =
  | typeof vendors
  | typeof items
  | typeof vendorItemAliases
  | typeof purchaseOrders
  | typeof grns
  | typeof purchaseInvoices;

/** Next free `<prefix><n>` code, e.g. V008, ITM-008, ALIAS-0001. */
function nextCode(
  q: Q,
  table: NumberedTable,
  column: AnySQLiteColumn,
  prefix: string,
  width: number,
): string {
  const n =
    (q
      .select({ n: count() })
      .from(table)
      .where(like(column, `${prefix}%`))
      .get()?.n ?? 0) + 1;
  for (let i = n; ; i++) {
    const candidate = `${prefix}${pad(i, width)}`;
    if (!q.select({ n: count() }).from(table).where(eq(column, candidate)).get()?.n)
      return candidate;
  }
}

/** Next document number in a per-FY series, e.g. AUTO/2026-27/1, GRN/2026-27/1, PINV/2026-27/1. */
function nextNumber(q: Q, table: NumberedTable, column: AnySQLiteColumn, prefix: string): string {
  return nextCode(q, table, column, prefix, 1);
}
