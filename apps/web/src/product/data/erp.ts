/**
 * Demo ERP records, exactly as in docs/DEMO.md §1.2–1.5 (the same data the fake ERP seeds).
 * Static fixtures for the product prototype; nothing here talks to an ERP.
 */
export interface DemoVendor {
  code: string;
  name: string;
  gstin: string;
  state: string;
  status: 'active' | 'inactive';
}

export const COMPANY = {
  name: 'Veyra Demo Industries Pvt Ltd',
  gstin: '29AAACS1111A1Z6',
  city: 'Bengaluru',
  state: 'Karnataka',
};

export const VENDORS: readonly DemoVendor[] = [
  {
    code: 'V001',
    name: 'Shakti Steel Suppliers Pvt Ltd',
    gstin: '29AAFCS5678K1ZK',
    state: 'Karnataka',
    status: 'active',
  },
  {
    code: 'V002',
    name: 'Apex Components Pvt Ltd',
    gstin: '27AAACA4321M1ZT',
    state: 'Maharashtra',
    status: 'active',
  },
  {
    code: 'V003',
    name: 'Bharat Packaging',
    gstin: '29ABCPB2468Q1Z9',
    state: 'Karnataka',
    status: 'inactive',
  },
  {
    code: 'V004',
    name: 'Kaveri Tools & Hardware Pvt Ltd',
    gstin: '33AAHCK1357R1Z3',
    state: 'Tamil Nadu',
    status: 'active',
  },
  {
    code: 'V005',
    name: 'Vasudha Traders',
    gstin: '29AAACV1234F1ZL',
    state: 'Karnataka',
    status: 'active',
  },
  {
    code: 'V006',
    name: 'Vasudha Traders & Co',
    gstin: '29AAJFV2222B1ZG',
    state: 'Karnataka',
    status: 'active',
  },
  {
    code: 'V007',
    name: 'Eastline Office Supplies Pvt Ltd',
    gstin: '29AAKCE3344D1ZP',
    state: 'Karnataka',
    status: 'active',
  },
];

export interface DemoItem {
  code: string;
  name: string;
  hsn: string;
  uom: string;
  gstRateBp: number;
}

export const ITEMS: readonly DemoItem[] = [
  { code: 'ITM-001', name: 'MS Steel Rod 12mm', hsn: '7214', uom: 'KGS', gstRateBp: 1800 },
  { code: 'ITM-002', name: 'MS Steel Plate 6mm', hsn: '7208', uom: 'KGS', gstRateBp: 1800 },
  { code: 'ITM-003', name: 'Ball Bearing 6204 ZZ', hsn: '8482', uom: 'NOS', gstRateBp: 1800 },
  { code: 'ITM-004', name: 'Corrugated Box 5 Ply', hsn: '4819', uom: 'NOS', gstRateBp: 1200 },
  { code: 'ITM-005', name: 'A4 Copier Paper 75 GSM', hsn: '4802', uom: 'REAM', gstRateBp: 1200 },
  { code: 'ITM-006', name: 'Cutting Disc 4 inch', hsn: '6804', uom: 'NOS', gstRateBp: 1800 },
  {
    code: 'ITM-007',
    name: 'Printer Toner Cartridge 88A',
    hsn: '8443',
    uom: 'NOS',
    gstRateBp: 1800,
  },
];

export interface DemoPo {
  number: string;
  vendorCode: string;
  date: string;
  status: 'open' | 'closed';
  lines: readonly { itemCode: string; qtyMilli: number; unitPricePaise: number }[];
  grn: { number: string; acceptedQtyMilli: readonly number[] } | null;
}

const u = (n: number): number => n * 1000;

export const PURCHASE_ORDERS: readonly DemoPo[] = [
  {
    number: 'PO-2026-0099',
    vendorCode: 'V001',
    date: '2026-08-05',
    status: 'closed',
    lines: [{ itemCode: 'ITM-001', qtyMilli: u(100), unitPricePaise: 6250 }],
    grn: { number: 'GRN-2026-0199', acceptedQtyMilli: [u(100)] },
  },
  {
    number: 'PO-2026-0101',
    vendorCode: 'V001',
    date: '2026-09-01',
    status: 'open',
    lines: [
      { itemCode: 'ITM-001', qtyMilli: u(1000), unitPricePaise: 6250 },
      { itemCode: 'ITM-002', qtyMilli: u(500), unitPricePaise: 6800 },
    ],
    grn: { number: 'GRN-2026-0201', acceptedQtyMilli: [u(1000), u(500)] },
  },
  {
    number: 'PO-2026-0102',
    vendorCode: 'V001',
    date: '2026-09-02',
    status: 'open',
    lines: [{ itemCode: 'ITM-001', qtyMilli: u(200), unitPricePaise: 6250 }],
    grn: { number: 'GRN-2026-0202', acceptedQtyMilli: [u(180)] },
  },
  {
    number: 'PO-2026-0103',
    vendorCode: 'V002',
    date: '2026-09-03',
    status: 'open',
    lines: [{ itemCode: 'ITM-003', qtyMilli: u(100), unitPricePaise: 14500 }],
    grn: { number: 'GRN-2026-0203', acceptedQtyMilli: [u(100)] },
  },
  {
    number: 'PO-2026-0104',
    vendorCode: 'V002',
    date: '2026-09-04',
    status: 'open',
    lines: [{ itemCode: 'ITM-003', qtyMilli: u(50), unitPricePaise: 14500 }],
    grn: null,
  },
  {
    number: 'PO-2026-0105',
    vendorCode: 'V004',
    date: '2026-09-05',
    status: 'open',
    lines: [{ itemCode: 'ITM-006', qtyMilli: u(200), unitPricePaise: 3800 }],
    grn: { number: 'GRN-2026-0204', acceptedQtyMilli: [u(200)] },
  },
  {
    number: 'PO-2026-0106',
    vendorCode: 'V004',
    date: '2026-09-06',
    status: 'open',
    lines: [{ itemCode: 'ITM-006', qtyMilli: u(100), unitPricePaise: 3800 }],
    grn: { number: 'GRN-2026-0205', acceptedQtyMilli: [u(100)] },
  },
  {
    number: 'PO-2026-0107',
    vendorCode: 'V003',
    date: '2026-09-07',
    status: 'open',
    lines: [{ itemCode: 'ITM-004', qtyMilli: u(500), unitPricePaise: 2400 }],
    grn: { number: 'GRN-2026-0206', acceptedQtyMilli: [u(500)] },
  },
  {
    number: 'PO-2026-0108',
    vendorCode: 'V005',
    date: '2026-09-08',
    status: 'open',
    lines: [{ itemCode: 'ITM-007', qtyMilli: u(10), unitPricePaise: 245000 }],
    grn: { number: 'GRN-2026-0207', acceptedQtyMilli: [u(10)] },
  },
  {
    number: 'PO-2026-0109',
    vendorCode: 'V001',
    date: '2026-09-09',
    status: 'open',
    lines: [{ itemCode: 'ITM-002', qtyMilli: u(100), unitPricePaise: 6800 }],
    grn: { number: 'GRN-2026-0208', acceptedQtyMilli: [u(100)] },
  },
  {
    number: 'PO-2026-0110',
    vendorCode: 'V001',
    date: '2026-09-10',
    status: 'open',
    lines: [{ itemCode: 'ITM-001', qtyMilli: u(100), unitPricePaise: 6250 }],
    grn: { number: 'GRN-2026-0209', acceptedQtyMilli: [u(100)] },
  },
  {
    number: 'PO-2026-0111',
    vendorCode: 'V002',
    date: '2026-09-11',
    status: 'open',
    lines: [{ itemCode: 'ITM-003', qtyMilli: u(20), unitPricePaise: 14500 }],
    grn: { number: 'GRN-2026-0210', acceptedQtyMilli: [u(20)] },
  },
  {
    number: 'PO-2026-0112',
    vendorCode: 'V001',
    date: '2026-09-12',
    status: 'open',
    lines: [{ itemCode: 'ITM-002', qtyMilli: u(200), unitPricePaise: 6800 }],
    grn: { number: 'GRN-2026-0211', acceptedQtyMilli: [u(200)] },
  },
];

export const vendorByCode = (code: string): DemoVendor | undefined =>
  VENDORS.find((v) => v.code === code);
export const itemByCode = (code: string): DemoItem | undefined =>
  ITEMS.find((i) => i.code === code);
