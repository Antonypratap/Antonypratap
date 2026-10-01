/**
 * The brewery sample business: the hosted demo's default ERP (docs/DEMO.md §10). Every company,
 * supplier, GSTIN and amount is made up; the GSTINs only pass the checksum. The manufacturing
 * business in `demo-data.ts` stays the regression seed of the test suite.
 *
 * It mirrors the manufacturing seed's situations, so every demo scenario has a brewery invoice:
 * a clean match, an order with no goods receipt, two suppliers that share a name, a quantity over
 * the order, a rate above the order, an OCR photo and two invoices in one file.
 * Money in paise, quantities in milli-units, rates in basis points.
 */
import type { SeedBusiness, SeedPurchaseOrder } from './demo-data';

const kg = (n: number): number => n * 1000;
const nos = kg;

export const BREWERY_COMPANY = {
  id: 'company',
  name: 'Hopsmith Brewing Co. Pvt Ltd',
  gstin: '29AAICH4826L1Z2',
  stateCode: '29',
} as const;

export const BREWERY_VENDORS = [
  {
    code: 'V001',
    name: 'Malabar Malt House Pvt Ltd',
    gstin: '29AABCM2468K1Z4',
    address: 'Karnataka',
    status: 'active',
  },
  {
    code: 'V002',
    name: 'Himalayan Hop Traders Pvt Ltd',
    gstin: '02AAECH1357P1ZI',
    address: 'Himachal Pradesh',
    status: 'active',
  },
  {
    code: 'V003',
    name: 'Deccan Glass Works',
    gstin: '36AAGFD9753Q1ZL',
    address: 'Telangana',
    status: 'inactive',
  },
  {
    code: 'V004',
    name: 'Coromandel Crown Closures Pvt Ltd',
    gstin: '33AAHCC8642R1Z1',
    address: 'Tamil Nadu',
    status: 'active',
  },
  {
    code: 'V005',
    name: 'Kaveri Cartons',
    gstin: '29ABKPK1122M1ZJ',
    address: 'Karnataka',
    status: 'active',
  },
  {
    code: 'V006',
    name: 'Kaveri Cartons & Co',
    gstin: '29AAJFK3344N1ZT',
    address: 'Karnataka',
    status: 'active',
  },
  {
    code: 'V007',
    name: 'Nandi Gases Pvt Ltd',
    gstin: '29AAKCN5566E1Z2',
    address: 'Karnataka',
    status: 'active',
  },
] as const;

export const BREWERY_ITEMS = [
  { code: 'ITM-001', name: 'Pilsner Malt', hsnSac: '1107', uom: 'KGS', gstRateBp: 1800 },
  { code: 'ITM-002', name: 'Munich Malt', hsnSac: '1107', uom: 'KGS', gstRateBp: 1800 },
  { code: 'ITM-003', name: 'Cascade Hop Pellets', hsnSac: '1210', uom: 'KGS', gstRateBp: 500 },
  { code: 'ITM-004', name: 'Amber Bottle 330 ml', hsnSac: '7010', uom: 'NOS', gstRateBp: 1800 },
  { code: 'ITM-005', name: 'Crown Cork 26 mm', hsnSac: '8309', uom: 'NOS', gstRateBp: 1800 },
  {
    code: 'ITM-006',
    name: 'Corrugated Carton 24 x 330 ml',
    hsnSac: '4819',
    uom: 'NOS',
    gstRateBp: 1800,
  },
  { code: 'ITM-007', name: 'Food Grade CO2', hsnSac: '2811', uom: 'KGS', gstRateBp: 1800 },
] as const;

export const BREWERY_PURCHASE_ORDERS: readonly SeedPurchaseOrder[] = [
  {
    poNumber: 'PO-2026-1101',
    vendorCode: 'V001',
    poDate: '2026-08-05',
    status: 'closed',
    lines: [{ itemCode: 'ITM-001', qtyMilli: kg(500), unitPricePaise: 5800 }],
    grn: { grnNumber: 'GRN-2026-1201', acceptedQtyMilli: [kg(500)] },
  },
  {
    poNumber: 'PO-2026-1102',
    vendorCode: 'V001',
    poDate: '2026-09-01',
    status: 'open',
    lines: [
      { itemCode: 'ITM-001', qtyMilli: kg(2000), unitPricePaise: 5800 },
      { itemCode: 'ITM-002', qtyMilli: kg(500), unitPricePaise: 6400 },
    ],
    grn: { grnNumber: 'GRN-2026-1202', acceptedQtyMilli: [kg(2000), kg(500)] },
  },
  // Demo "Clean invoice".
  {
    poNumber: 'PO-2026-1103',
    vendorCode: 'V001',
    poDate: '2026-09-02',
    status: 'open',
    lines: [{ itemCode: 'ITM-001', qtyMilli: kg(1000), unitPricePaise: 5800 }],
    grn: { grnNumber: 'GRN-2026-1203', acceptedQtyMilli: [kg(1000)] },
  },
  {
    poNumber: 'PO-2026-1104',
    vendorCode: 'V002',
    poDate: '2026-09-03',
    status: 'open',
    lines: [{ itemCode: 'ITM-003', qtyMilli: kg(50), unitPricePaise: 145000 }],
    grn: { grnNumber: 'GRN-2026-1204', acceptedQtyMilli: [kg(50)] },
  },
  // Demo "Missing goods receipt": ordered, nothing received yet.
  {
    poNumber: 'PO-2026-1105',
    vendorCode: 'V002',
    poDate: '2026-09-04',
    status: 'open',
    lines: [{ itemCode: 'ITM-003', qtyMilli: kg(20), unitPricePaise: 145000 }],
    grn: null,
  },
  // Demo "Rate mismatch": ordered at ₹1,450.00 per kg.
  {
    poNumber: 'PO-2026-1106',
    vendorCode: 'V002',
    poDate: '2026-09-05',
    status: 'open',
    lines: [{ itemCode: 'ITM-003', qtyMilli: kg(10), unitPricePaise: 145000 }],
    grn: { grnNumber: 'GRN-2026-1206', acceptedQtyMilli: [kg(10)] },
  },
  // Demo "Quantity mismatch": 20,000 ordered and received.
  {
    poNumber: 'PO-2026-1107',
    vendorCode: 'V004',
    poDate: '2026-09-06',
    status: 'open',
    lines: [{ itemCode: 'ITM-005', qtyMilli: nos(20000), unitPricePaise: 45 }],
    grn: { grnNumber: 'GRN-2026-1207', acceptedQtyMilli: [nos(20000)] },
  },
  // Demo "Ambiguous supplier": the order belongs to Kaveri Cartons (V005).
  {
    poNumber: 'PO-2026-1108',
    vendorCode: 'V005',
    poDate: '2026-09-07',
    status: 'open',
    lines: [{ itemCode: 'ITM-006', qtyMilli: nos(2000), unitPricePaise: 1850 }],
    grn: { grnNumber: 'GRN-2026-1208', acceptedQtyMilli: [nos(2000)] },
  },
  // Demo "Photo needs confirmation".
  {
    poNumber: 'PO-2026-1109',
    vendorCode: 'V001',
    poDate: '2026-09-08',
    status: 'open',
    lines: [{ itemCode: 'ITM-002', qtyMilli: kg(300), unitPricePaise: 6400 }],
    grn: { grnNumber: 'GRN-2026-1209', acceptedQtyMilli: [kg(300)] },
  },
  // Demo "Two invoices in one file".
  {
    poNumber: 'PO-2026-1110',
    vendorCode: 'V001',
    poDate: '2026-09-09',
    status: 'open',
    lines: [{ itemCode: 'ITM-001', qtyMilli: kg(100), unitPricePaise: 5800 }],
    grn: { grnNumber: 'GRN-2026-1210', acceptedQtyMilli: [kg(100)] },
  },
  {
    poNumber: 'PO-2026-1111',
    vendorCode: 'V003',
    poDate: '2026-09-10',
    status: 'open',
    lines: [{ itemCode: 'ITM-004', qtyMilli: nos(10000), unitPricePaise: 920 }],
    grn: { grnNumber: 'GRN-2026-1211', acceptedQtyMilli: [nos(10000)] },
  },
  {
    poNumber: 'PO-2026-1112',
    vendorCode: 'V004',
    poDate: '2026-09-11',
    status: 'open',
    lines: [{ itemCode: 'ITM-005', qtyMilli: nos(10000), unitPricePaise: 45 }],
    grn: { grnNumber: 'GRN-2026-1212', acceptedQtyMilli: [nos(10000)] },
  },
];

export const BREWERY_BUSINESS: SeedBusiness = {
  company: BREWERY_COMPANY,
  vendors: BREWERY_VENDORS,
  items: BREWERY_ITEMS,
  purchaseOrders: BREWERY_PURCHASE_ORDERS,
};
