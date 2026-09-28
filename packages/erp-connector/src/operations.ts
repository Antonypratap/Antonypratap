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
] as const;
export type ErpReadOperation = (typeof ERP_READ_OPERATIONS)[number];

/** Every write, in the order COMMITTING executes them (ARCHITECTURE §4.3). No payment operation exists. */
export const ERP_WRITE_OPERATIONS = [
  'reactivateVendor',
  'createVendor',
  'createItem',
  'createVendorItemAlias',
  'createPurchaseOrder',
  'createGrn',
  'recordPurchaseInvoice',
] as const;
export type ErpWriteOperation = (typeof ERP_WRITE_OPERATIONS)[number];

export type ErpOperation = ErpReadOperation | ErpWriteOperation;
