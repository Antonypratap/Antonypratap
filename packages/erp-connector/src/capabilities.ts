import type { ErpOperation } from './operations';

/**
 * What an ERP connector can do (Phase 4). Not every ERP supports every operation: a connector
 * declares its capabilities, and an operation outside them throws ErpUnsupportedOperationError
 * (code UNSUPPORTED). Veyra never falls back to another behaviour.
 */
export const ERP_CAPABILITIES = [
  // Read
  'vendor.read',
  'item.read',
  'purchase_order.read',
  'goods_receipt.read',
  'purchase_invoice.read',
  // Write
  'vendor.create',
  'vendor.reactivate',
  'item.create',
  'vendor_item_alias.create',
  'purchase_order.create',
  'goods_receipt.create',
  'purchase_invoice.create',
  // Optional
  'vendor.one_time',
  'business_records.import',
  'write.reconcile',
] as const;
export type ErpCapability = (typeof ERP_CAPABILITIES)[number];

/** The capability each operation needs. `getCompany` and `checkConnection` need none. */
export const OPERATION_CAPABILITY: Readonly<Record<ErpOperation, ErpCapability | null>> = {
  getCompany: null,
  getVendor: 'vendor.read',
  findVendorByGstin: 'vendor.read',
  findVendorsByPan: 'vendor.read',
  findVendorsByNormalizedName: 'vendor.read',
  listVendors: 'vendor.read',
  getItem: 'item.read',
  findItemByVendorAlias: 'item.read',
  findItemsByNormalizedNameAndHsn: 'item.read',
  findItemsByHsn: 'item.read',
  listItems: 'item.read',
  getPurchaseOrder: 'purchase_order.read',
  getPurchaseOrderByNumber: 'purchase_order.read',
  listOpenPurchaseOrders: 'purchase_order.read',
  listPurchaseOrders: 'purchase_order.read',
  listGrnsForPo: 'goods_receipt.read',
  listGrns: 'goods_receipt.read',
  getInvoicedQtyByPoLine: 'purchase_invoice.read',
  findPurchaseInvoice: 'purchase_invoice.read',
  listPurchaseInvoices: 'purchase_invoice.read',
  reconcileWrite: 'write.reconcile',
  reactivateVendor: 'vendor.reactivate',
  createVendor: 'vendor.create',
  createItem: 'item.create',
  createVendorItemAlias: 'vendor_item_alias.create',
  createPurchaseOrder: 'purchase_order.create',
  createGrn: 'goods_receipt.create',
  recordPurchaseInvoice: 'purchase_invoice.create',
  importBusinessRecords: 'business_records.import',
};

/** How each capability reads to a person (the ERP connection screen). */
export const CAPABILITY_LABEL: Readonly<Record<ErpCapability, string>> = {
  'vendor.read': 'Read suppliers',
  'item.read': 'Read items',
  'purchase_order.read': 'Read purchase orders',
  'goods_receipt.read': 'Read goods receipts',
  'purchase_invoice.read': 'Read purchase invoices',
  'vendor.create': 'Add suppliers',
  'vendor.reactivate': 'Reactivate suppliers',
  'item.create': 'Add items',
  'vendor_item_alias.create': "Link suppliers' item codes",
  'purchase_order.create': 'Create purchase orders',
  'goods_receipt.create': 'Record goods receipts',
  'purchase_invoice.create': 'Record purchase invoices',
  'vendor.one_time': 'One-time suppliers',
  'business_records.import': 'Import business records',
  'write.reconcile': 'Confirm the outcome of a write',
};

export function supports(
  capabilities: readonly ErpCapability[],
  capability: ErpCapability,
): boolean {
  return capabilities.includes(capability);
}

/** Whether a connector with these capabilities may run the operation. */
export function supportsOperation(
  capabilities: readonly ErpCapability[],
  operation: ErpOperation,
): boolean {
  const needed = OPERATION_CAPABILITY[operation];
  return needed === null || capabilities.includes(needed);
}
