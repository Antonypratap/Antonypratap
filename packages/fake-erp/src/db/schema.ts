/**
 * fake_erp.db schema (ARCHITECTURE §4.1). Private to @veyra/fake-erp: nothing outside this
 * package may import it. Everything else reaches ERP data only through ErpConnector.
 *
 * Money is integer paise, quantities integer milli-units and rates integer basis points.
 * SQLite does not enforce column types, so every integer column carries a
 * `typeof(col) = 'integer'` CHECK: a REAL (floating-point) value can never be stored.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

const isInt = (c: AnySQLiteColumn): SQL => sql`typeof(${c}) = 'integer'`;
const isIntOrNull = (c: AnySQLiteColumn): SQL => sql`(${c} IS NULL OR typeof(${c}) = 'integer')`;
const isDate = (c: AnySQLiteColumn): SQL => sql`date(${c}) IS ${c}`;
const isTimestamp = (c: AnySQLiteColumn): SQL =>
  sql`${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'`;
const isGstin = (c: AnySQLiteColumn): SQL => sql`length(${c}) = 15 AND ${c} GLOB '[0-9][0-9]*'`;
const isRateBp = (c: AnySQLiteColumn): SQL =>
  sql`typeof(${c}) = 'integer' AND ${c} BETWEEN 0 AND 10000`;
const isHsn = (c: AnySQLiteColumn): SQL =>
  sql`length(${c}) IN (4, 6, 8) AND ${c} NOT GLOB '*[^0-9]*'`;
/** A record created by Veyra references its source invoice; a seeded one does not. */
const originMatchesSource = (origin: AnySQLiteColumn, source: AnySQLiteColumn): SQL =>
  sql`(${origin} = 'seed') = (${source} IS NULL)`;

export const company = sqliteTable(
  'company',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    gstin: text('gstin').notNull().unique(),
    stateCode: text('state_code').notNull(),
  },
  (t) => [
    check('company_singleton', sql`${t.id} = 'company'`),
    check('company_gstin', isGstin(t.gstin)),
    check('company_state_matches_gstin', sql`${t.stateCode} = substr(${t.gstin}, 1, 2)`),
  ],
);

export const vendors = sqliteTable(
  'vendors',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    gstin: text('gstin').notNull().unique(),
    pan: text('pan').notNull(),
    stateCode: text('state_code').notNull(),
    address: text('address').notNull(),
    status: text('status', { enum: ['active', 'inactive'] }).notNull(),
    origin: text('origin', { enum: ['seed', 'created_by_veyra'] }).notNull(),
    sourceInvoiceId: text('source_invoice_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('vendors_pan_idx').on(t.pan),
    index('vendors_name_normalized_idx').on(t.nameNormalized),
    check('vendors_gstin', isGstin(t.gstin)),
    check('vendors_pan_matches_gstin', sql`${t.pan} = substr(${t.gstin}, 3, 10)`),
    check('vendors_state_matches_gstin', sql`${t.stateCode} = substr(${t.gstin}, 1, 2)`),
    check('vendors_status', sql`${t.status} IN ('active', 'inactive')`),
    check('vendors_origin', sql`${t.origin} IN ('seed', 'created_by_veyra')`),
    check('vendors_origin_source', originMatchesSource(t.origin, t.sourceInvoiceId)),
    check('vendors_created_at', isTimestamp(t.createdAt)),
  ],
);

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    hsnSac: text('hsn_sac').notNull(),
    uom: text('uom').notNull(),
    gstRateBp: integer('gst_rate_bp').notNull(),
    origin: text('origin', { enum: ['seed', 'created_by_veyra'] }).notNull(),
    sourceInvoiceId: text('source_invoice_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('items_hsn_idx').on(t.hsnSac),
    index('items_name_hsn_idx').on(t.nameNormalized, t.hsnSac),
    check('items_hsn', isHsn(t.hsnSac)),
    check('items_gst_rate', isRateBp(t.gstRateBp)),
    check('items_origin', sql`${t.origin} IN ('seed', 'created_by_veyra')`),
    check('items_origin_source', originMatchesSource(t.origin, t.sourceInvoiceId)),
    check('items_created_at', isTimestamp(t.createdAt)),
  ],
);

export const vendorItemAliases = sqliteTable(
  'vendor_item_aliases',
  {
    id: text('id').primaryKey(),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => vendors.id),
    vendorItemCode: text('vendor_item_code').notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    origin: text('origin', { enum: ['seed', 'created_by_veyra'] }).notNull(),
    sourceInvoiceId: text('source_invoice_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    unique('vendor_item_aliases_vendor_code_uq').on(t.vendorId, t.vendorItemCode),
    index('vendor_item_aliases_item_idx').on(t.itemId),
    check('vendor_item_aliases_code', sql`length(${t.vendorItemCode}) > 0`),
    check('vendor_item_aliases_origin', sql`${t.origin} IN ('seed', 'created_by_veyra')`),
    check('vendor_item_aliases_origin_source', originMatchesSource(t.origin, t.sourceInvoiceId)),
    check('vendor_item_aliases_created_at', isTimestamp(t.createdAt)),
  ],
);

export const purchaseOrders = sqliteTable(
  'purchase_orders',
  {
    id: text('id').primaryKey(),
    poNumber: text('po_number').notNull().unique(),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => vendors.id),
    poDate: text('po_date').notNull(),
    status: text('status', { enum: ['open', 'closed'] }).notNull(),
    origin: text('origin', {
      enum: ['seed', 'auto_created_from_invoice', 'created_from_invoice_on_approval'],
    }).notNull(),
    sourceInvoiceId: text('source_invoice_id'),
    approvedByUserId: text('approved_by_user_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('purchase_orders_vendor_idx').on(t.vendorId),
    check('purchase_orders_date', isDate(t.poDate)),
    check('purchase_orders_status', sql`${t.status} IN ('open', 'closed')`),
    check(
      'purchase_orders_origin',
      sql`${t.origin} IN ('seed', 'auto_created_from_invoice', 'created_from_invoice_on_approval')`,
    ),
    check('purchase_orders_origin_source', originMatchesSource(t.origin, t.sourceInvoiceId)),
    check(
      'purchase_orders_origin_approver',
      sql`(${t.origin} = 'created_from_invoice_on_approval') = (${t.approvedByUserId} IS NOT NULL)`,
    ),
    check('purchase_orders_created_at', isTimestamp(t.createdAt)),
  ],
);

export const poLines = sqliteTable(
  'po_lines',
  {
    id: text('id').primaryKey(),
    poId: text('po_id')
      .notNull()
      .references(() => purchaseOrders.id),
    lineNo: integer('line_no').notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    qtyMilli: integer('qty_milli').notNull(),
    unitPricePaise: integer('unit_price_paise').notNull(),
    gstRateBp: integer('gst_rate_bp').notNull(),
  },
  (t) => [
    unique('po_lines_po_line_uq').on(t.poId, t.lineNo),
    index('po_lines_item_idx').on(t.itemId),
    check('po_lines_line_no', sql`${isInt(t.lineNo)} AND ${t.lineNo} > 0`),
    check('po_lines_qty', sql`${isInt(t.qtyMilli)} AND ${t.qtyMilli} > 0`),
    check('po_lines_price', sql`${isInt(t.unitPricePaise)} AND ${t.unitPricePaise} >= 0`),
    check('po_lines_gst_rate', isRateBp(t.gstRateBp)),
  ],
);

export const grns = sqliteTable(
  'grns',
  {
    id: text('id').primaryKey(),
    grnNumber: text('grn_number').notNull().unique(),
    poId: text('po_id')
      .notNull()
      .references(() => purchaseOrders.id),
    grnDate: text('grn_date').notNull(),
    origin: text('origin', { enum: ['seed', 'user_confirmed_via_veyra'] }).notNull(),
    confirmedByUserId: text('confirmed_by_user_id'),
    sourceInvoiceId: text('source_invoice_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('grns_po_idx').on(t.poId),
    check('grns_date', isDate(t.grnDate)),
    check('grns_origin', sql`${t.origin} IN ('seed', 'user_confirmed_via_veyra')`),
    check('grns_origin_source', originMatchesSource(t.origin, t.sourceInvoiceId)),
    check(
      'grns_origin_confirmer',
      sql`(${t.origin} = 'user_confirmed_via_veyra') = (${t.confirmedByUserId} IS NOT NULL)`,
    ),
    check('grns_created_at', isTimestamp(t.createdAt)),
  ],
);

export const grnLines = sqliteTable(
  'grn_lines',
  {
    id: text('id').primaryKey(),
    grnId: text('grn_id')
      .notNull()
      .references(() => grns.id),
    poLineId: text('po_line_id')
      .notNull()
      .references(() => poLines.id),
    receivedQtyMilli: integer('received_qty_milli').notNull(),
    acceptedQtyMilli: integer('accepted_qty_milli').notNull(),
  },
  (t) => [
    unique('grn_lines_grn_po_line_uq').on(t.grnId, t.poLineId),
    index('grn_lines_po_line_idx').on(t.poLineId),
    check('grn_lines_received', sql`${isInt(t.receivedQtyMilli)} AND ${t.receivedQtyMilli} > 0`),
    check(
      'grn_lines_accepted',
      sql`${isInt(t.acceptedQtyMilli)} AND ${t.acceptedQtyMilli} >= 0 AND ${t.acceptedQtyMilli} <= ${t.receivedQtyMilli}`,
    ),
  ],
);

export const purchaseInvoices = sqliteTable(
  'purchase_invoices',
  {
    id: text('id').primaryKey(),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => vendors.id),
    vendorInvoiceNo: text('vendor_invoice_no').notNull(),
    vendorInvoiceNoNormalized: text('vendor_invoice_no_normalized').notNull(),
    invoiceDate: text('invoice_date').notNull(),
    fy: text('fy').notNull(),
    poId: text('po_id')
      .notNull()
      .references(() => purchaseOrders.id),
    taxablePaise: integer('taxable_paise').notNull(),
    cgstPaise: integer('cgst_paise').notNull(),
    sgstPaise: integer('sgst_paise').notNull(),
    igstPaise: integer('igst_paise').notNull(),
    roundOffPaise: integer('round_off_paise'),
    totalPaise: integer('total_paise').notNull(),
    status: text('status', { enum: ['verified_pending_payment'] }).notNull(),
    veyraInvoiceId: text('veyra_invoice_id').notNull().unique(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    unique('purchase_invoices_vendor_no_fy_uq').on(t.vendorId, t.vendorInvoiceNoNormalized, t.fy),
    index('purchase_invoices_po_idx').on(t.poId),
    check('purchase_invoices_date', isDate(t.invoiceDate)),
    check('purchase_invoices_fy', sql`${t.fy} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`),
    check('purchase_invoices_taxable', sql`${isInt(t.taxablePaise)} AND ${t.taxablePaise} >= 0`),
    check('purchase_invoices_cgst', sql`${isInt(t.cgstPaise)} AND ${t.cgstPaise} >= 0`),
    check('purchase_invoices_sgst', sql`${isInt(t.sgstPaise)} AND ${t.sgstPaise} >= 0`),
    check('purchase_invoices_igst', sql`${isInt(t.igstPaise)} AND ${t.igstPaise} >= 0`),
    check('purchase_invoices_round_off', isIntOrNull(t.roundOffPaise)),
    check('purchase_invoices_total_int', sql`${isInt(t.totalPaise)} AND ${t.totalPaise} >= 0`),
    check(
      'purchase_invoices_total',
      sql`${t.totalPaise} = ${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.igstPaise} + coalesce(${t.roundOffPaise}, 0)`,
    ),
    // V1 has no payment: this is the only status that can exist.
    check('purchase_invoices_status', sql`${t.status} = 'verified_pending_payment'`),
    check('purchase_invoices_created_at', isTimestamp(t.createdAt)),
  ],
);

export const purchaseInvoiceLines = sqliteTable(
  'purchase_invoice_lines',
  {
    id: text('id').primaryKey(),
    purchaseInvoiceId: text('purchase_invoice_id')
      .notNull()
      .references(() => purchaseInvoices.id),
    lineNo: integer('line_no').notNull(),
    poLineId: text('po_line_id')
      .notNull()
      .references(() => poLines.id),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    qtyMilli: integer('qty_milli').notNull(),
    unitPricePaise: integer('unit_price_paise').notNull(),
    taxablePaise: integer('taxable_paise').notNull(),
    gstRateBp: integer('gst_rate_bp').notNull(),
    cgstPaise: integer('cgst_paise'),
    sgstPaise: integer('sgst_paise'),
    igstPaise: integer('igst_paise'),
  },
  (t) => [
    unique('purchase_invoice_lines_line_uq').on(t.purchaseInvoiceId, t.lineNo),
    index('purchase_invoice_lines_po_line_idx').on(t.poLineId),
    check('purchase_invoice_lines_line_no', sql`${isInt(t.lineNo)} AND ${t.lineNo} > 0`),
    check('purchase_invoice_lines_qty', sql`${isInt(t.qtyMilli)} AND ${t.qtyMilli} > 0`),
    check(
      'purchase_invoice_lines_price',
      sql`${isInt(t.unitPricePaise)} AND ${t.unitPricePaise} >= 0`,
    ),
    check(
      'purchase_invoice_lines_taxable',
      sql`${isInt(t.taxablePaise)} AND ${t.taxablePaise} >= 0`,
    ),
    check('purchase_invoice_lines_gst_rate', isRateBp(t.gstRateBp)),
    check('purchase_invoice_lines_cgst', isIntOrNull(t.cgstPaise)),
    check('purchase_invoice_lines_sgst', isIntOrNull(t.sgstPaise)),
    check('purchase_invoice_lines_igst', isIntOrNull(t.igstPaise)),
  ],
);

/** ERP-side idempotency ledger (ARCHITECTURE §3.2 idempotency contract, decision D4). */
export const idempotencyLog = sqliteTable(
  'idempotency_log',
  {
    key: text('key').primaryKey(),
    operation: text('operation').notNull(),
    payloadHash: text('payload_hash').notNull(),
    resultId: text('result_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check(
      'idempotency_log_operation',
      sql`${t.operation} IN ('reactivateVendor', 'createVendor', 'createItem', 'createVendorItemAlias', 'createPurchaseOrder', 'createGrn', 'recordPurchaseInvoice')`,
    ),
    check(
      'idempotency_log_hash',
      sql`length(${t.payloadHash}) = 64 AND ${t.payloadHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check('idempotency_log_created_at', isTimestamp(t.createdAt)),
  ],
);

/** Tables in dependency order (parents first). Reset deletes in reverse. */
export const TABLES_IN_DEPENDENCY_ORDER = [
  company,
  vendors,
  items,
  vendorItemAliases,
  purchaseOrders,
  poLines,
  grns,
  grnLines,
  purchaseInvoices,
  purchaseInvoiceLines,
  idempotencyLog,
] as const;
