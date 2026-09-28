/**
 * The business-record tables Veyra can import (Phase 3C), one per template sheet. The columns are
 * exactly what the ERP record model holds (packages/erp-connector/src/inputs.ts); nothing extra is
 * invented. Optional columns marked "check" are not stored: they are compared with the record
 * they describe (e.g. PAN and state are derived from the GSTIN), so a mistake is caught.
 */

export type TableKey =
  'vendors' | 'items' | 'purchaseOrders' | 'purchaseOrderLines' | 'grns' | 'grnLines';

export type ColumnKind =
  | 'code'
  | 'text'
  | 'gstin'
  | 'pan'
  | 'state'
  | 'yesno'
  | 'hsn'
  | 'uom'
  | 'rate'
  | 'date'
  | 'poStatus'
  | 'lineNumber'
  | 'qty'
  | 'money';

export interface ColumnSpec {
  name: string;
  label: string;
  kind: ColumnKind;
  required: boolean;
  description: string;
  example: string;
  width: number;
}

export interface TableSpec {
  key: TableKey;
  /** Sheet name in templates, and the name Veyra looks for when reading a workbook. */
  sheet: string;
  /** Singular/plural nouns for messages ("vendor", "vendors"). */
  noun: [string, string];
  /** Template file for this table alone. */
  file: string;
  columns: ColumnSpec[];
}

/** Rows whose first column starts with this are template examples and are never imported. */
export const EXAMPLE_PREFIX = 'EXAMPLE-';

const col = (
  name: string,
  label: string,
  kind: ColumnKind,
  required: boolean,
  description: string,
  example: string,
  width = 18,
): ColumnSpec => ({ name, label, kind, required, description, example, width });

export const TABLES: readonly TableSpec[] = [
  {
    key: 'vendors',
    sheet: 'Vendors',
    noun: ['vendor', 'vendors'],
    file: 'Vendors.xlsx',
    columns: [
      col(
        'vendor_code',
        'Vendor code',
        'code',
        true,
        'Your code for the supplier. Letters, digits, space . _ / -',
        'EXAMPLE-V01',
        16,
      ),
      col(
        'name',
        'Name',
        'text',
        true,
        'Legal or trade name of the supplier.',
        'Example Supplier Pvt Ltd (example row)',
        36,
      ),
      col(
        'gstin',
        'GSTIN',
        'gstin',
        true,
        '15-character GSTIN. Veyra checks the state code and check digit.',
        '29AAECE1234F1ZY',
        18,
      ),
      col(
        'pan',
        'PAN',
        'pan',
        false,
        'Optional check: must equal characters 3–12 of the GSTIN.',
        'AAECE1234F',
        14,
      ),
      col(
        'address',
        'Address',
        'text',
        true,
        'Registered address.',
        'Example address, Bengaluru 560001',
        36,
      ),
      col(
        'state',
        'State',
        'state',
        false,
        'Optional check: must match the GSTIN state (name or 2-digit code).',
        'Karnataka',
        14,
      ),
      col(
        'active',
        'Active',
        'yesno',
        true,
        'yes or no. Invoices from inactive suppliers need your decision.',
        'yes',
        10,
      ),
    ],
  },
  {
    key: 'items',
    sheet: 'Items',
    noun: ['item', 'items'],
    file: 'Items.xlsx',
    columns: [
      col('item_code', 'Item code', 'code', true, 'Your code for the item.', 'EXAMPLE-I01', 16),
      col(
        'name',
        'Name',
        'text',
        true,
        'Item name as you use it.',
        'Example item (example row)',
        34,
      ),
      col('hsn', 'HSN/SAC', 'hsn', true, '4, 6 or 8 digits.', '7214', 12),
      col(
        'uom',
        'Unit',
        'uom',
        true,
        'KGS, NOS, PCS, REAM, BOX, MTR, LTR or SET. NOS and PCS are different units.',
        'KGS',
        10,
      ),
      col(
        'gst_rate',
        'GST rate',
        'rate',
        true,
        'GST rate as a percentage, e.g. 18 or 18%.',
        '18',
        10,
      ),
    ],
  },
  {
    key: 'purchaseOrders',
    sheet: 'Purchase orders',
    noun: ['purchase order', 'purchase orders'],
    file: 'PurchaseOrders.xlsx',
    columns: [
      col(
        'po_number',
        'PO number',
        'code',
        true,
        'Your purchase order number.',
        'EXAMPLE-PO-1',
        18,
      ),
      col(
        'vendor_code',
        'Vendor code',
        'code',
        true,
        'A vendor in your records or in this upload.',
        'EXAMPLE-V01',
        16,
      ),
      col(
        'po_date',
        'PO date',
        'date',
        true,
        'YYYY-MM-DD or DD/MM/YYYY. Not in the future.',
        '2026-09-01',
        14,
      ),
      col('status', 'Status', 'poStatus', true, 'open or closed.', 'open', 10),
    ],
  },
  {
    key: 'purchaseOrderLines',
    sheet: 'Purchase order lines',
    noun: ['purchase order line', 'purchase order lines'],
    file: 'PurchaseOrderLines.xlsx',
    columns: [
      col(
        'po_number',
        'PO number',
        'code',
        true,
        'The purchase order this line belongs to. Upload lines with their order.',
        'EXAMPLE-PO-1',
        18,
      ),
      col(
        'line_number',
        'Line',
        'lineNumber',
        true,
        'Lines of each order are numbered 1, 2, 3 …',
        '1',
        8,
      ),
      col(
        'item_code',
        'Item code',
        'code',
        true,
        'An item in your records or in this upload.',
        'EXAMPLE-I01',
        16,
      ),
      col(
        'quantity',
        'Quantity',
        'qty',
        true,
        'Ordered quantity, more than zero, up to 3 decimals.',
        '100',
        12,
      ),
      col(
        'unit_rate',
        'Unit rate',
        'money',
        true,
        'Price per unit in rupees, up to 2 decimals (no GST).',
        '62.50',
        12,
      ),
      col('gst_rate', 'GST rate', 'rate', true, 'GST rate agreed on the order, e.g. 18.', '18', 10),
      col('uom', 'Unit', 'uom', false, "Optional check: must equal the item's unit.", 'KGS', 10),
    ],
  },
  {
    key: 'grns',
    sheet: 'Goods receipts',
    noun: ['goods receipt', 'goods receipts'],
    file: 'GoodsReceipts.xlsx',
    columns: [
      col(
        'grn_number',
        'GRN number',
        'code',
        true,
        'Your goods receipt number.',
        'EXAMPLE-GRN-1',
        18,
      ),
      col(
        'po_number',
        'PO number',
        'code',
        true,
        'The purchase order the goods were received against.',
        'EXAMPLE-PO-1',
        18,
      ),
      col(
        'grn_date',
        'Received on',
        'date',
        true,
        'YYYY-MM-DD or DD/MM/YYYY. Not before the PO date, not in the future.',
        '2026-09-02',
        14,
      ),
    ],
  },
  {
    key: 'grnLines',
    sheet: 'Goods receipt lines',
    noun: ['goods receipt line', 'goods receipt lines'],
    file: 'GoodsReceiptLines.xlsx',
    columns: [
      col(
        'grn_number',
        'GRN number',
        'code',
        true,
        'The goods receipt this line belongs to. Upload lines with their receipt.',
        'EXAMPLE-GRN-1',
        18,
      ),
      col(
        'po_line_number',
        'PO line',
        'lineNumber',
        true,
        'The line of the purchase order that was received.',
        '1',
        10,
      ),
      col(
        'item_code',
        'Item code',
        'code',
        true,
        'Check: must be the item on that PO line.',
        'EXAMPLE-I01',
        16,
      ),
      col(
        'received_quantity',
        'Received',
        'qty',
        true,
        'Quantity received, more than zero.',
        '100',
        12,
      ),
      col(
        'accepted_quantity',
        'Accepted',
        'qty',
        true,
        'Quantity accepted. Cannot be more than received.',
        '100',
        12,
      ),
      col('uom', 'Unit', 'uom', false, "Optional check: must equal the item's unit.", 'KGS', 10),
    ],
  },
];

export const tableSpec = (key: TableKey): TableSpec => {
  const t = TABLES.find((x) => x.key === key);
  if (!t) throw new Error(`unknown table ${key}`);
  return t;
};

/** Which tables each downloadable template contains (lines travel with their headers). */
export const TEMPLATE_FILES: Readonly<Record<string, { title: string; tables: TableKey[] }>> = {
  'Veyra-Master-Data-Import.xlsx': {
    title: 'All business records',
    tables: ['vendors', 'items', 'purchaseOrders', 'purchaseOrderLines', 'grns', 'grnLines'],
  },
  'Vendors.xlsx': { title: 'Vendors', tables: ['vendors'] },
  'Items.xlsx': { title: 'Items', tables: ['items'] },
  'PurchaseOrders.xlsx': { title: 'Purchase orders', tables: ['purchaseOrders'] },
  'PurchaseOrderLines.xlsx': { title: 'Purchase order lines', tables: ['purchaseOrderLines'] },
  'GoodsReceipts.xlsx': { title: 'Goods receipts', tables: ['grns'] },
  'GoodsReceiptLines.xlsx': { title: 'Goods receipt lines', tables: ['grnLines'] },
};

/** Normalised sheet/file names Veyra accepts for each table. */
export const TABLE_ALIASES: Readonly<Record<string, TableKey>> = {
  vendors: 'vendors',
  suppliers: 'vendors',
  items: 'items',
  purchaseorders: 'purchaseOrders',
  pos: 'purchaseOrders',
  purchaseorderlines: 'purchaseOrderLines',
  polines: 'purchaseOrderLines',
  goodsreceipts: 'grns',
  grns: 'grns',
  goodsreceiptlines: 'grnLines',
  grnlines: 'grnLines',
};
