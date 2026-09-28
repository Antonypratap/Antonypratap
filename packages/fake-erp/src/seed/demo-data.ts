/**
 * Seed data, exactly as specified in docs/DEMO.md §1.2–1.5.
 * Money in paise, quantities in milli-units, rates in basis points.
 *
 * DEMO.md gives one GRN quantity per line ("accepted") and no GRN dates or vendor addresses, so:
 * received = accepted, GRN date = PO date, and a vendor's address is its state name.
 */

export const SEED_CREATED_AT = '2026-08-01T00:00:00.000Z';

export const DEMO_COMPANY = {
  id: 'company',
  name: 'Veyra Demo Industries Pvt Ltd',
  gstin: '29AAACS1111A1Z6',
  stateCode: '29',
} as const;

export const DEMO_VENDORS = [
  {
    code: 'V001',
    name: 'Shakti Steel Suppliers Pvt Ltd',
    gstin: '29AAFCS5678K1ZK',
    address: 'Karnataka',
    status: 'active',
  },
  {
    code: 'V002',
    name: 'Apex Components Pvt Ltd',
    gstin: '27AAACA4321M1ZT',
    address: 'Maharashtra',
    status: 'active',
  },
  {
    code: 'V003',
    name: 'Bharat Packaging',
    gstin: '29ABCPB2468Q1Z9',
    address: 'Karnataka',
    status: 'inactive',
  },
  {
    code: 'V004',
    name: 'Kaveri Tools & Hardware Pvt Ltd',
    gstin: '33AAHCK1357R1Z3',
    address: 'Tamil Nadu',
    status: 'active',
  },
  {
    code: 'V005',
    name: 'Vasudha Traders',
    gstin: '29AAACV1234F1ZL',
    address: 'Karnataka',
    status: 'active',
  },
  {
    code: 'V006',
    name: 'Vasudha Traders & Co',
    gstin: '29AAJFV2222B1ZG',
    address: 'Karnataka',
    status: 'active',
  },
  {
    code: 'V007',
    name: 'Eastline Office Supplies Pvt Ltd',
    gstin: '29AAKCE3344D1ZP',
    address: 'Karnataka',
    status: 'active',
  },
] as const;

export const DEMO_ITEMS = [
  { code: 'ITM-001', name: 'MS Steel Rod 12mm', hsnSac: '7214', uom: 'KGS', gstRateBp: 1800 },
  { code: 'ITM-002', name: 'MS Steel Plate 6mm', hsnSac: '7208', uom: 'KGS', gstRateBp: 1800 },
  { code: 'ITM-003', name: 'Ball Bearing 6204 ZZ', hsnSac: '8482', uom: 'NOS', gstRateBp: 1800 },
  { code: 'ITM-004', name: 'Corrugated Box 5 Ply', hsnSac: '4819', uom: 'NOS', gstRateBp: 1200 },
  { code: 'ITM-005', name: 'A4 Copier Paper 75 GSM', hsnSac: '4802', uom: 'REAM', gstRateBp: 1200 },
  { code: 'ITM-006', name: 'Cutting Disc 4 inch', hsnSac: '6804', uom: 'NOS', gstRateBp: 1800 },
  {
    code: 'ITM-007',
    name: 'Printer Toner Cartridge 88A',
    hsnSac: '8443',
    uom: 'NOS',
    gstRateBp: 1800,
  },
] as const;

interface DemoPo {
  poNumber: string;
  vendorCode: string;
  poDate: string;
  status: 'open' | 'closed';
  lines: readonly { itemCode: string; qtyMilli: number; unitPricePaise: number }[];
  /** Accepted quantity per PO line (same order), or null when the PO has no GRN. */
  grn: { grnNumber: string; acceptedQtyMilli: readonly number[] } | null;
}

const kg = (n: number): number => n * 1000;
const nos = kg;

export const DEMO_PURCHASE_ORDERS: readonly DemoPo[] = [
  {
    poNumber: 'PO-2026-0099',
    vendorCode: 'V001',
    poDate: '2026-08-05',
    status: 'closed',
    lines: [{ itemCode: 'ITM-001', qtyMilli: kg(100), unitPricePaise: 6250 }],
    grn: { grnNumber: 'GRN-2026-0199', acceptedQtyMilli: [kg(100)] },
  },
  {
    poNumber: 'PO-2026-0101',
    vendorCode: 'V001',
    poDate: '2026-09-01',
    status: 'open',
    lines: [
      { itemCode: 'ITM-001', qtyMilli: kg(1000), unitPricePaise: 6250 },
      { itemCode: 'ITM-002', qtyMilli: kg(500), unitPricePaise: 6800 },
    ],
    grn: { grnNumber: 'GRN-2026-0201', acceptedQtyMilli: [kg(1000), kg(500)] },
  },
  {
    poNumber: 'PO-2026-0102',
    vendorCode: 'V001',
    poDate: '2026-09-02',
    status: 'open',
    lines: [{ itemCode: 'ITM-001', qtyMilli: kg(200), unitPricePaise: 6250 }],
    grn: { grnNumber: 'GRN-2026-0202', acceptedQtyMilli: [kg(180)] },
  },
  {
    poNumber: 'PO-2026-0103',
    vendorCode: 'V002',
    poDate: '2026-09-03',
    status: 'open',
    lines: [{ itemCode: 'ITM-003', qtyMilli: nos(100), unitPricePaise: 14500 }],
    grn: { grnNumber: 'GRN-2026-0203', acceptedQtyMilli: [nos(100)] },
  },
  {
    poNumber: 'PO-2026-0104',
    vendorCode: 'V002',
    poDate: '2026-09-04',
    status: 'open',
    lines: [{ itemCode: 'ITM-003', qtyMilli: nos(50), unitPricePaise: 14500 }],
    grn: null,
  },
  {
    poNumber: 'PO-2026-0105',
    vendorCode: 'V004',
    poDate: '2026-09-05',
    status: 'open',
    lines: [{ itemCode: 'ITM-006', qtyMilli: nos(200), unitPricePaise: 3800 }],
    grn: { grnNumber: 'GRN-2026-0204', acceptedQtyMilli: [nos(200)] },
  },
  {
    poNumber: 'PO-2026-0106',
    vendorCode: 'V004',
    poDate: '2026-09-06',
    status: 'open',
    lines: [{ itemCode: 'ITM-006', qtyMilli: nos(100), unitPricePaise: 3800 }],
    grn: { grnNumber: 'GRN-2026-0205', acceptedQtyMilli: [nos(100)] },
  },
  {
    poNumber: 'PO-2026-0107',
    vendorCode: 'V003',
    poDate: '2026-09-07',
    status: 'open',
    lines: [{ itemCode: 'ITM-004', qtyMilli: nos(500), unitPricePaise: 2400 }],
    grn: { grnNumber: 'GRN-2026-0206', acceptedQtyMilli: [nos(500)] },
  },
  {
    poNumber: 'PO-2026-0108',
    vendorCode: 'V005',
    poDate: '2026-09-08',
    status: 'open',
    lines: [{ itemCode: 'ITM-007', qtyMilli: nos(10), unitPricePaise: 245000 }],
    grn: { grnNumber: 'GRN-2026-0207', acceptedQtyMilli: [nos(10)] },
  },
  {
    poNumber: 'PO-2026-0109',
    vendorCode: 'V001',
    poDate: '2026-09-09',
    status: 'open',
    lines: [{ itemCode: 'ITM-002', qtyMilli: kg(100), unitPricePaise: 6800 }],
    grn: { grnNumber: 'GRN-2026-0208', acceptedQtyMilli: [kg(100)] },
  },
  {
    poNumber: 'PO-2026-0110',
    vendorCode: 'V001',
    poDate: '2026-09-10',
    status: 'open',
    lines: [{ itemCode: 'ITM-001', qtyMilli: kg(100), unitPricePaise: 6250 }],
    grn: { grnNumber: 'GRN-2026-0209', acceptedQtyMilli: [kg(100)] },
  },
  {
    poNumber: 'PO-2026-0111',
    vendorCode: 'V002',
    poDate: '2026-09-11',
    status: 'open',
    lines: [{ itemCode: 'ITM-003', qtyMilli: nos(20), unitPricePaise: 14500 }],
    grn: { grnNumber: 'GRN-2026-0210', acceptedQtyMilli: [nos(20)] },
  },
  {
    poNumber: 'PO-2026-0112',
    vendorCode: 'V001',
    poDate: '2026-09-12',
    status: 'open',
    lines: [{ itemCode: 'ITM-002', qtyMilli: kg(200), unitPricePaise: 6800 }],
    grn: { grnNumber: 'GRN-2026-0211', acceptedQtyMilli: [kg(200)] },
  },
];
