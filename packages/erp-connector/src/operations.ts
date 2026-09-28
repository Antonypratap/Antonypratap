export const ERP_READ_OPERATIONS = [
  'getCompany',
  'getVendor',
  'findVendorByGstin',
  'findVendorsByPan',
  'findVendorsByNormalizedName',
  'getItem',
  'findItemByVendorAlias',
  'findItemsByNormalizedNameAndHsn',
  'findItemsByHsn',
  'getPurchaseOrder',
  'getPurchaseOrderByNumber',
  'listOpenPurchaseOrders',
  'listGrnsForPo',
  'getInvoicedQtyByPoLine',
  'findPurchaseInvoice',
  'listVendors',
  'listItems',
  'listPurchaseOrders',
  'listGrns',
  'listPurchaseInvoices',
  // Phase 4: what did a write with this key do? (reconciliation of a lost response)
  'reconcileWrite',
] as const;
export type ErpReadOperation = (typeof ERP_READ_OPERATIONS)[number];

/** Every write. The first seven are in the order COMMITTING executes them (ARCHITECTURE §4.3). No payment operation exists. */
export const ERP_WRITE_OPERATIONS = [
  'reactivateVendor',
  'createVendor',
  'createItem',
  'createVendorItemAlias',
  'createPurchaseOrder',
  'createGrn',
  'recordPurchaseInvoice',
  // Not part of an invoice commit: imports a batch of the business's own records (Phase 3C).
  'importBusinessRecords',
] as const;
export type ErpWriteOperation = (typeof ERP_WRITE_OPERATIONS)[number];

export type ErpOperation = ErpReadOperation | ErpWriteOperation;
