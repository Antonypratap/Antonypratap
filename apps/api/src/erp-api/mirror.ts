import {
  ErpUnsupportedOperationError,
  type Company,
  type ErpCapability,
  type ErpConnectionCheck,
  type ErpConnector,
  type ErpWriteReconciliation,
  type Grn,
  type Item,
  type PurchaseOrder,
  type RecordedPurchaseInvoice,
  type Vendor,
} from '@veyra/erp-connector';
import {
  financialYearOf,
  validateGstin,
  isValidHsnSac,
  type FinancialYear,
} from '@veyra/india-tax';
import { normalizeInvoiceNumber, normalizeName, type ErpId, type IsoDate } from '@veyra/shared';
import type { BillDoc, DocOf, GrnDoc, ItemDoc, PoDoc, VendorDoc } from './mapping';
import type { Entity } from './profile';

/**
 * The ERP's records as Veyrafy reads them during invoice checks: the synced mirror, turned into
 * the same records every ErpConnector returns, through the existing port. The matching engine
 * does not know (or need to know) that they came over an API.
 *
 * Nothing is guessed:
 * - a record that cannot become a complete Veyrafy record (a supplier without a valid GSTIN, an
 *   item without HSN, unit or GST rate) is left out and reported, so the engine asks instead;
 * - a link that does not resolve (a PO for an unknown supplier, a goods receipt line that matches
 *   no PO line or several) leaves the record out and is reported;
 * - two records claiming the same GSTIN or the same PO number are a conflict: lookups by that key
 *   find nothing certain, so the engine falls back to asking which one is meant;
 * - records the ERP no longer returns (missing since a full sync) are not used.
 *
 * Read-only: no write capability is declared, so every write is refused as unsupported (the
 * capability guard rejects it before it gets here; the methods below refuse too).
 */

export interface MirrorRow {
  entity: Entity;
  erpId: string;
  company: string;
  outlet: string;
  doc: DocOf[Entity];
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedRunId: string;
  missingSince: string | null;
}

export type IssueKind = 'incomplete' | 'orphan' | 'conflict';
export interface IndexIssue {
  entity: Entity;
  erpId: string;
  kind: IssueKind;
  /** Field names or a short reason code; never values. */
  detail: string[];
}

/** Where a record a finding relies on came from (for traceability). */
export interface Provenance {
  entity: Entity;
  erpId: string;
  syncedAt: string;
}

const READ_CAPABILITIES: readonly ErpCapability[] = [
  'vendor.read',
  'item.read',
  'purchase_order.read',
  'goods_receipt.read',
  'purchase_invoice.read',
];

const NOT_IN_ERP = 'Not recorded in the ERP';

export class MirrorIndex {
  readonly vendors = new Map<string, Vendor>();
  readonly items = new Map<string, Item>();
  readonly pos = new Map<string, PurchaseOrder>();
  readonly grns = new Map<string, Grn>();
  readonly bills: RecordedPurchaseInvoice[] = [];
  readonly issues: IndexIssue[] = [];
  readonly provenance = new Map<string, Provenance>();
  /** Keys held by more than one record: lookups by them return nothing certain. */
  readonly #conflictGstins = new Set<string>();
  readonly #conflictPoNumbers = new Set<string>();

  constructor(rows: readonly MirrorRow[]) {
    const live = rows.filter((r) => r.missingSince === null);
    const of = <E extends Entity>(e: E) =>
      live.filter((r) => r.entity === e) as (MirrorRow & { doc: DocOf[E] })[];

    // Suppliers.
    const vendorRef = new Map<string, string[]>();
    const addRef = (map: Map<string, string[]>, key: string | null, id: string) => {
      if (!key) return;
      map.set(key, [...(map.get(key) ?? []), id]);
    };
    for (const r of of('vendors')) {
      const v = this.#vendor(r);
      if (!v) continue;
      this.vendors.set(r.erpId, v);
      this.#track('vendors', r);
      addRef(vendorRef, r.erpId, r.erpId);
      if (r.doc.code && r.doc.code !== r.erpId) addRef(vendorRef, r.doc.code, r.erpId);
    }
    const byGstin = new Map<string, string[]>();
    for (const v of this.vendors.values()) addRef(byGstin, v.gstin, v.id);
    for (const [gstin, ids] of byGstin)
      if (ids.length > 1) {
        this.#conflictGstins.add(gstin);
        for (const id of ids) this.#issue('vendors', id, 'conflict', ['gstin']);
      }

    // Items.
    const itemRef = new Map<string, string[]>();
    for (const r of of('items')) {
      const i = this.#item(r);
      if (!i) continue;
      this.items.set(r.erpId, i);
      this.#track('items', r);
      addRef(itemRef, r.erpId, r.erpId);
      if (r.doc.code && r.doc.code !== r.erpId) addRef(itemRef, r.doc.code, r.erpId);
    }

    const resolve = (map: Map<string, string[]>, key: string): string | null | 'ambiguous' => {
      const ids = [...new Set(map.get(key) ?? [])];
      return ids.length === 1 ? (ids[0] as string) : ids.length > 1 ? 'ambiguous' : null;
    };

    // Purchase orders.
    const poRef = new Map<string, string[]>();
    for (const r of of('purchase_orders')) {
      const po = this.#po(
        r,
        (k) => resolve(vendorRef, k),
        (k) => resolve(itemRef, k),
      );
      if (!po) continue;
      this.pos.set(r.erpId, po);
      this.#track('purchase_orders', r);
      addRef(poRef, r.erpId, r.erpId);
      if (r.doc.poNumber !== r.erpId) addRef(poRef, r.doc.poNumber, r.erpId);
    }
    const byNumber = new Map<string, string[]>();
    for (const po of this.pos.values()) addRef(byNumber, po.poNumber, po.id);
    for (const [no, ids] of byNumber)
      if (ids.length > 1) {
        this.#conflictPoNumbers.add(no);
        for (const id of ids) this.#issue('purchase_orders', id, 'conflict', ['poNumber']);
      }

    // Goods receipts.
    for (const r of of('grns')) {
      const g = this.#grn(
        r,
        (k) => resolve(poRef, k),
        (k) => resolve(itemRef, k),
      );
      if (!g) continue;
      this.grns.set(r.erpId, g);
      this.#track('grns', r);
    }

    // Purchase bills the ERP already holds (for the duplicate check).
    for (const r of of('bills')) {
      const b = this.#bill(r, (k) => resolve(vendorRef, k));
      if (!b) continue;
      this.bills.push(b);
      this.#track('bills', r);
    }
  }

  #track(entity: Entity, r: MirrorRow) {
    this.provenance.set(`${entity}:${r.erpId}`, { entity, erpId: r.erpId, syncedAt: r.lastSeenAt });
  }

  #issue(entity: Entity, erpId: string, kind: IssueKind, detail: string[]) {
    this.issues.push({ entity, erpId, kind, detail });
  }

  #vendor(r: MirrorRow & { doc: VendorDoc }): Vendor | null {
    const d = r.doc;
    const g = d.gstin ? validateGstin(d.gstin) : null;
    if (!g?.ok) {
      this.#issue('vendors', r.erpId, 'incomplete', ['gstin']);
      return null;
    }
    const gstin = g.value.gstin;
    return {
      id: r.erpId as ErpId,
      code: d.code ?? r.erpId,
      name: d.name,
      nameNormalized: normalizeName(d.name),
      gstin,
      pan: gstin.slice(2, 12),
      stateCode: gstin.slice(0, 2),
      address: d.address ?? NOT_IN_ERP,
      status: d.status ?? 'active',
      origin: 'imported',
      sourceInvoiceId: null,
      sourceImportId: `erp-sync:${r.lastChangedRunId}`,
      createdAt: r.firstSeenAt,
    } as Vendor;
  }

  #item(r: MirrorRow & { doc: ItemDoc }): Item | null {
    const d = r.doc;
    const missing = [
      ...(d.hsnSac && isValidHsnSac(d.hsnSac) ? [] : ['hsnSac']),
      ...(d.uom ? [] : ['uom']),
      ...(d.gstRateBp !== null && d.gstRateBp <= 10_000 ? [] : ['gstRateBp']),
    ];
    if (missing.length > 0) {
      this.#issue('items', r.erpId, 'incomplete', missing);
      return null;
    }
    return {
      id: r.erpId as ErpId,
      code: d.code ?? r.erpId,
      name: d.name,
      nameNormalized: normalizeName(d.name),
      hsnSac: d.hsnSac,
      uom: d.uom,
      gstRateBp: d.gstRateBp,
      origin: 'imported',
      sourceInvoiceId: null,
      sourceImportId: `erp-sync:${r.lastChangedRunId}`,
      createdAt: r.firstSeenAt,
    } as Item;
  }

  #po(
    r: MirrorRow & { doc: PoDoc },
    vendor: (k: string) => string | null | 'ambiguous',
    item: (k: string) => string | null | 'ambiguous',
  ): PurchaseOrder | null {
    const d = r.doc;
    const vendorId = vendor(d.vendorRef);
    if (vendorId === null || vendorId === 'ambiguous') {
      this.#issue('purchase_orders', r.erpId, vendorId === null ? 'orphan' : 'conflict', [
        'vendorRef',
      ]);
      return null;
    }
    const bad: string[] = [];
    const lines = d.lines.map((l, i) => {
      const itemId = item(l.itemRef);
      if (itemId === null || itemId === 'ambiguous') bad.push(`lines.${String(i + 1)}.itemRef`);
      const rate =
        l.gstRateBp ??
        (itemId && itemId !== 'ambiguous' ? (this.items.get(itemId)?.gstRateBp ?? null) : null);
      if (rate === null) bad.push(`lines.${String(i + 1)}.gstRateBp`);
      if (l.qtyMilli <= 0) bad.push(`lines.${String(i + 1)}.qtyMilli`);
      return {
        // Lines are numbered 1..n as received; the ERP's own line id or number stays in the id.
        id: `${r.erpId}#${l.lineRef ?? String(l.lineNo ?? i + 1)}` as ErpId,
        poId: r.erpId as ErpId,
        lineNo: i + 1,
        itemId: (typeof itemId === 'string' ? itemId : '') as ErpId,
        qtyMilli: l.qtyMilli,
        unitPricePaise: l.unitPricePaise,
        gstRateBp: rate ?? 0,
        erpLineKeys: [l.lineRef, l.lineNo === null ? null : String(l.lineNo)],
      };
    });
    if (bad.length > 0) {
      this.#issue(
        'purchase_orders',
        r.erpId,
        bad.some((b) => b.endsWith('itemRef')) ? 'orphan' : 'incomplete',
        bad,
      );
      return null;
    }
    this.#lineKeys.set(
      r.erpId,
      lines.map((l) => ({
        id: l.id,
        keys: l.erpLineKeys.filter((k): k is string => k !== null),
        itemId: l.itemId,
      })),
    );
    return {
      id: r.erpId as ErpId,
      poNumber: d.poNumber,
      vendorId: vendorId as ErpId,
      poDate: d.poDate as IsoDate,
      status: d.status ?? 'open',
      origin: 'imported',
      sourceInvoiceId: null,
      approvedByUserId: null,
      sourceImportId: `erp-sync:${r.lastChangedRunId}`,
      createdAt: r.firstSeenAt,
      lines: lines.map((l) => ({
        id: l.id,
        poId: l.poId,
        lineNo: l.lineNo,
        itemId: l.itemId,
        qtyMilli: l.qtyMilli,
        unitPricePaise: l.unitPricePaise,
        gstRateBp: l.gstRateBp,
      })),
    } as PurchaseOrder;
  }

  /** For each PO: its lines, with the ERP's own line keys, to resolve goods-receipt lines. */
  readonly #lineKeys = new Map<string, { id: ErpId; keys: string[]; itemId: ErpId }[]>();

  #grn(
    r: MirrorRow & { doc: GrnDoc },
    po: (k: string) => string | null | 'ambiguous',
    item: (k: string) => string | null | 'ambiguous',
  ): Grn | null {
    const d = r.doc;
    const poId = po(d.poRef);
    if (poId === null || poId === 'ambiguous') {
      this.#issue('grns', r.erpId, poId === null ? 'orphan' : 'conflict', ['poRef']);
      return null;
    }
    const poLines = this.#lineKeys.get(poId) ?? [];
    const bad: string[] = [];
    const lines = d.lines.map((l, i) => {
      let candidates = l.poLineRef
        ? poLines.filter((pl) => pl.keys.includes(l.poLineRef ?? ''))
        : [];
      if (candidates.length === 0 && l.itemRef) {
        const itemId = item(l.itemRef);
        candidates =
          typeof itemId === 'string' && itemId !== 'ambiguous'
            ? poLines.filter((pl) => pl.itemId === itemId)
            : [];
      }
      // Exactly one PO line, or the receipt line is not used (never a guess between lines).
      if (candidates.length !== 1) bad.push(`lines.${String(i + 1)}.poLine`);
      const received = l.receivedQtyMilli ?? l.acceptedQtyMilli;
      if (l.acceptedQtyMilli > received) bad.push(`lines.${String(i + 1)}.acceptedQtyMilli`);
      return {
        id: `${r.erpId}#${String(i + 1)}` as ErpId,
        grnId: r.erpId as ErpId,
        poLineId: (candidates[0]?.id ?? '') as ErpId,
        receivedQtyMilli: received,
        acceptedQtyMilli: l.acceptedQtyMilli,
      };
    });
    if (bad.length > 0) {
      this.#issue('grns', r.erpId, 'orphan', bad);
      return null;
    }
    return {
      id: r.erpId as ErpId,
      grnNumber: d.grnNumber,
      poId: poId as ErpId,
      grnDate: d.grnDate as IsoDate,
      origin: 'imported',
      confirmedByUserId: null,
      sourceInvoiceId: null,
      sourceImportId: `erp-sync:${r.lastChangedRunId}`,
      createdAt: r.firstSeenAt,
      lines,
    } as Grn;
  }

  #bill(
    r: MirrorRow & { doc: BillDoc },
    vendor: (k: string) => string | null | 'ambiguous',
  ): RecordedPurchaseInvoice | null {
    const d = r.doc;
    const vendorId = vendor(d.vendorRef);
    if (vendorId === null || vendorId === 'ambiguous') {
      this.#issue('bills', r.erpId, vendorId === null ? 'orphan' : 'conflict', ['vendorRef']);
      return null;
    }
    return {
      id: r.erpId as ErpId,
      vendorId: vendorId as ErpId,
      vendorInvoiceNo: d.billNumber,
      invoiceDate: d.billDate as IsoDate,
      fy: financialYearOf(d.billDate as IsoDate),
      totalPaise: d.totalPaise as RecordedPurchaseInvoice['totalPaise'],
      createdAt: r.firstSeenAt as RecordedPurchaseInvoice['createdAt'],
      veyraInvoiceId: null,
    };
  }

  vendorByGstin(gstin: string): Vendor | null {
    if (this.#conflictGstins.has(gstin)) return null;
    for (const v of this.vendors.values()) if (v.gstin === gstin) return v;
    return null;
  }

  poByNumber(poNumber: string): PurchaseOrder | null {
    if (this.#conflictPoNumbers.has(poNumber)) return null;
    for (const po of this.pos.values()) if (po.poNumber === poNumber) return po;
    return null;
  }
}

export interface MirrorSource {
  /** The current index (rebuilt by the caller after each sync). */
  index(): Promise<MirrorIndex>;
  /** The business this deployment serves (from the built-in records' company). */
  company(): Promise<Company>;
  /** Connection status for the ERP screen and health. */
  check(): Promise<ErpConnectionCheck>;
  displayName(): string;
}

const sortBy = <T>(xs: T[], key: (x: T) => string) =>
  [...xs].sort((a, b) => key(a).localeCompare(key(b)));

export class MirroredErpConnector implements ErpConnector {
  constructor(private readonly src: MirrorSource) {}

  get info() {
    return {
      name: 'erp-api',
      version: '1',
      type: 'erp-api',
      displayName: this.src.displayName(),
    };
  }

  capabilities(): readonly ErpCapability[] {
    return READ_CAPABILITIES;
  }

  checkConnection(): Promise<ErpConnectionCheck> {
    return this.src.check();
  }

  reconcileWrite(): Promise<ErpWriteReconciliation> {
    return Promise.reject(new ErpUnsupportedOperationError('reconcileWrite' as never));
  }

  getCompany(): Promise<Company> {
    return this.src.company();
  }

  async getVendor(vendorId: ErpId) {
    return (await this.src.index()).vendors.get(vendorId) ?? null;
  }
  async findVendorByGstin(gstin: string) {
    return (await this.src.index()).vendorByGstin(gstin);
  }
  async findVendorsByPan(pan: string) {
    return sortBy(
      [...(await this.src.index()).vendors.values()].filter((v) => v.pan === pan),
      (v) => v.code,
    );
  }
  async findVendorsByNormalizedName(normalizedName: string) {
    return sortBy(
      [...(await this.src.index()).vendors.values()].filter(
        (v) => v.nameNormalized === normalizedName,
      ),
      (v) => v.code,
    );
  }

  async getItem(itemId: ErpId) {
    return (await this.src.index()).items.get(itemId) ?? null;
  }
  /** API connections carry no supplier item codes in phase 1: never a guess. */
  findItemByVendorAlias(): Promise<Item | null> {
    return Promise.resolve(null);
  }
  async findItemsByNormalizedNameAndHsn(normalizedName: string, hsnSac: string) {
    return sortBy(
      [...(await this.src.index()).items.values()].filter(
        (i) => i.nameNormalized === normalizedName && i.hsnSac === hsnSac,
      ),
      (i) => i.code,
    );
  }
  async findItemsByHsn(hsnSac: string) {
    return sortBy(
      [...(await this.src.index()).items.values()].filter((i) => i.hsnSac === hsnSac),
      (i) => i.code,
    );
  }

  async getPurchaseOrder(poId: ErpId) {
    return (await this.src.index()).pos.get(poId) ?? null;
  }
  async getPurchaseOrderByNumber(poNumber: string) {
    return (await this.src.index()).poByNumber(poNumber);
  }
  async listOpenPurchaseOrders(vendorId: ErpId) {
    return sortBy(
      [...(await this.src.index()).pos.values()].filter(
        (p) => p.vendorId === vendorId && p.status === 'open',
      ),
      (p) => p.poNumber,
    );
  }
  async listGrnsForPo(poId: ErpId) {
    return sortBy(
      [...(await this.src.index()).grns.values()].filter((g) => g.poId === poId),
      (g) => g.grnNumber,
    );
  }
  /**
   * Quantity already billed against a PO line. Bills read over an API carry no lines in phase 1,
   * so this is 0 (documented limitation: over-billing across several invoices on one PO line is
   * caught only for invoices that pass through Veyrafy).
   */
  getInvoicedQtyByPoLine(): Promise<never> {
    return Promise.resolve(0 as never);
  }

  async findPurchaseInvoice(vendorId: ErpId, normalizedInvoiceNo: string, fy: FinancialYear) {
    return (
      (await this.src.index()).bills.find(
        (b) =>
          b.vendorId === vendorId &&
          normalizeInvoiceNumber(b.vendorInvoiceNo) === normalizedInvoiceNo &&
          b.fy === fy,
      ) ?? null
    );
  }

  async listVendors() {
    return sortBy([...(await this.src.index()).vendors.values()], (v) => v.code);
  }
  async listItems() {
    return sortBy([...(await this.src.index()).items.values()], (i) => i.code);
  }
  async listPurchaseOrders() {
    return sortBy([...(await this.src.index()).pos.values()], (p) => p.poNumber);
  }
  async listGrns() {
    return sortBy([...(await this.src.index()).grns.values()], (g) => g.grnNumber);
  }
  /** Bills the ERP booked itself are not Veyrafy purchase invoices; none are listed here. */
  listPurchaseInvoices(): Promise<never[]> {
    return Promise.resolve([]);
  }

  #refuse(op: string): Promise<never> {
    return Promise.reject(new ErpUnsupportedOperationError(op as never));
  }
  reactivateVendor() {
    return this.#refuse('reactivateVendor');
  }
  createVendor() {
    return this.#refuse('createVendor');
  }
  createItem() {
    return this.#refuse('createItem');
  }
  createVendorItemAlias() {
    return this.#refuse('createVendorItemAlias');
  }
  createPurchaseOrder() {
    return this.#refuse('createPurchaseOrder');
  }
  createGrn() {
    return this.#refuse('createGrn');
  }
  recordPurchaseInvoice() {
    return this.#refuse('recordPurchaseInvoice');
  }
  importBusinessRecords() {
    return this.#refuse('importBusinessRecords');
  }
}
