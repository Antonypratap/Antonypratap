import type { ErpId, IdempotencyKey, MilliQty } from '@veyra/shared';
import type { FinancialYear, Gstin, Pan } from '@veyra/india-tax';
import type {
  Company,
  Grn,
  Item,
  PurchaseInvoice,
  PurchaseOrder,
  Vendor,
  VendorItemAlias,
} from './entities';
import type {
  CreateGrnInput,
  CreateItemInput,
  CreatePurchaseOrderInput,
  CreateVendorInput,
  CreateVendorItemAliasInput,
  ReactivateVendorInput,
  RecordPurchaseInvoiceInput,
} from './inputs';

export interface ErpConnectorInfo {
  /** e.g. "fake-erp", "tally" */
  name: string;
  version: string;
}

/**
 * The only way Veyra reads or writes ERP data (ARCHITECTURE §3.2). The fake ERP is one
 * implementation; a real ERP connector replaces it without changes elsewhere.
 *
 * Contract (verified by `describeErpConnectorContract` from `@veyra/erp-connector/contract`):
 * - Returned records parse with the schemas in `entities.ts`.
 * - Lookups by key (`get*`, `find*`) return null / [] when nothing matches; they never guess,
 *   never fuzzy-match, and compare exactly the (already normalised) values they are given.
 * - Operations scoped to a parent id (`list*`, `getInvoicedQtyByPoLine`) throw ErpNotFoundError
 *   when the parent does not exist.
 * - Writes validate their input (ErpValidationError), resolve references (ErpNotFoundError),
 *   enforce natural keys (ErpConflictError) and follow the idempotency contract in
 *   `idempotency.ts`. Writes are used only by the COMMITTING stage.
 * - Every error thrown is an ErpConnectorError; ErpUnavailableError is the only retryable one.
 * - There is deliberately no payment operation.
 */
export interface ErpConnector {
  readonly info: ErpConnectorInfo;

  // ── Company ──────────────────────────────────────────────────────────────
  getCompany(): Promise<Company>;

  // ── Vendors ──────────────────────────────────────────────────────────────
  getVendor(vendorId: ErpId): Promise<Vendor | null>;
  findVendorByGstin(gstin: Gstin): Promise<Vendor | null>;
  findVendorsByPan(pan: Pan): Promise<Vendor[]>;
  /** `normalizedName` must already be `normalizeName(...)` output; matched exactly. */
  findVendorsByNormalizedName(normalizedName: string): Promise<Vendor[]>;

  // ── Items and vendor-item aliases ────────────────────────────────────────
  getItem(itemId: ErpId): Promise<Item | null>;
  /** Exact match on the vendor's item code as printed. */
  findItemByVendorAlias(vendorId: ErpId, vendorItemCode: string): Promise<Item | null>;
  findItemsByNormalizedNameAndHsn(normalizedName: string, hsnSac: string): Promise<Item[]>;
  findItemsByHsn(hsnSac: string): Promise<Item[]>;

  // ── Purchase orders and GRNs ─────────────────────────────────────────────
  getPurchaseOrder(poId: ErpId): Promise<PurchaseOrder | null>;
  /** Exact match on the PO number. */
  getPurchaseOrderByNumber(poNumber: string): Promise<PurchaseOrder | null>;
  /** Open = status `open` and at least one line with uninvoiced quantity (RULES §2.2). */
  listOpenPurchaseOrders(vendorId: ErpId): Promise<PurchaseOrder[]>;
  listGrnsForPo(poId: ErpId): Promise<Grn[]>;
  /** Quantity already invoiced against a PO line in recorded purchase invoices. */
  getInvoicedQtyByPoLine(poLineId: ErpId): Promise<MilliQty>;

  // ── Purchase invoices ────────────────────────────────────────────────────
  /** `normalizedInvoiceNo` must be `normalizeInvoiceNumber(...)` output. */
  findPurchaseInvoice(
    vendorId: ErpId,
    normalizedInvoiceNo: string,
    fy: FinancialYear,
  ): Promise<PurchaseInvoice | null>;

  // ── Writes (COMMITTING only; all idempotent on `key`) ────────────────────
  /** Returns the vendor, active. Reactivating an already active vendor changes nothing. */
  reactivateVendor(input: ReactivateVendorInput, key: IdempotencyKey): Promise<Vendor>;
  /** Natural key: GSTIN. The ERP assigns the code and derives PAN, state and normalised name. */
  createVendor(input: CreateVendorInput, key: IdempotencyKey): Promise<Vendor>;
  /** The ERP assigns the item code and derives the normalised name. */
  createItem(input: CreateItemInput, key: IdempotencyKey): Promise<Item>;
  /** Natural key: (vendorId, vendorItemCode). */
  createVendorItemAlias(
    input: CreateVendorItemAliasInput,
    key: IdempotencyKey,
  ): Promise<VendorItemAlias>;
  /** The ERP assigns the PO number. Lines are stored exactly as given; status starts `open`. */
  createPurchaseOrder(input: CreatePurchaseOrderInput, key: IdempotencyKey): Promise<PurchaseOrder>;
  /** The ERP assigns the GRN number; origin is `user_confirmed_via_veyra`. */
  createGrn(input: CreateGrnInput, key: IdempotencyKey): Promise<Grn>;
  /**
   * Natural key: (vendorId, normalised invoice number, FY). Status is `verified_pending_payment`.
   * `key` must be `purchaseInvoiceIdempotencyKey(input.veyraInvoiceId)`.
   */
  recordPurchaseInvoice(
    input: RecordPurchaseInvoiceInput,
    key: IdempotencyKey,
  ): Promise<PurchaseInvoice>;
}
