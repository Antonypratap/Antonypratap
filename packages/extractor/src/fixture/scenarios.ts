/**
 * Demo invoice scenarios (docs/DEMO.md §2, plus S19 for a unit-of-measure mismatch).
 *
 * Each scenario states what is PRINTED on the invoice and how well it can be read. It carries no
 * decision: a printed PO number that does not exist, a wrong tax figure or an unreadable GSTIN are
 * just facts here. The deterministic engine decides what happens next.
 *
 * Money in paise, quantities in milli-units, rates in basis points.
 */

export const DEMO_BUYER = {
  name: 'Veyra Demo Industries Pvt Ltd',
  gstin: '29AAACS1111A1Z6',
  address: 'Peenya Industrial Area, Bengaluru 560058',
} as const;

export interface ScenarioLine {
  description: string;
  vendorItemCode?: string;
  hsnSac: string;
  qtyMilli: number;
  uom: string;
  unitPricePaise: number;
  taxablePaise: number;
  gstRateBp: number;
}

/** A field that was read badly: the extractor proposes `value` with low confidence. */
export interface WeakRead {
  value: string | number | null;
  confidenceBp: number;
}

export interface FixtureScenario {
  id: string;
  file: string;
  kind: 'pdf' | 'photo';
  title: string;
  vendor: { name: string; gstin: string; address: string };
  buyerGstin: string;
  /** Printed "Place of Supply" text, or null when not printed. */
  placeOfSupply: string | null;
  shipTo?: { state?: string; gstin?: string };
  invoiceNumber: string;
  invoiceDate: string;
  poNumber: string | null;
  lines: readonly ScenarioLine[];
  taxablePaise: number;
  cgstPaise: number | null;
  sgstPaise: number | null;
  igstPaise: number | null;
  roundOffPaise: number | null;
  totalPaise: number;
  /** Header fields the photo leaves hard to read, by header key. */
  weak?: Partial<Record<'vendorGstin' | 'totalPaise', WeakRead>>;
}

const KA = 'Karnataka (29)';
/** Whole units to milli-units. */
const units = (n: number): number => n * 1000;

const SHAKTI = {
  name: 'Shakti Steel Suppliers Pvt Ltd',
  gstin: '29AAFCS5678K1ZK',
  address: 'Plot 14, Peenya 2nd Stage, Bengaluru 560058',
};
const APEX = {
  name: 'Apex Components Pvt Ltd',
  gstin: '27AAACA4321M1ZT',
  address: 'Bhosari MIDC, Pune 411026',
};
const EASTLINE = {
  name: 'Eastline Office Supplies Pvt Ltd',
  gstin: '29AAKCE3344D1ZP',
  address: '12 Residency Road, Bengaluru 560025',
};

const ROD = { description: 'MS Steel Rod 12mm', hsnSac: '7214', uom: 'KGS', gstRateBp: 1800 };
const PLATE = { description: 'MS Steel Plate 6mm', hsnSac: '7208', uom: 'KGS', gstRateBp: 1800 };
const BEARING = { description: 'Ball Bearing 6204 ZZ', hsnSac: '8482', gstRateBp: 1800 };
const TONER = {
  description: 'Printer Toner Cartridge 88A',
  hsnSac: '8443',
  uom: 'NOS',
  gstRateBp: 1800,
};

const S01_BASE = {
  vendor: SHAKTI,
  buyerGstin: DEMO_BUYER.gstin,
  placeOfSupply: KA,
  invoiceNumber: 'SSS/26-27/0451',
  invoiceDate: '2026-09-15',
  poNumber: 'PO-2026-0101',
  lines: [
    { ...ROD, qtyMilli: units(1000), unitPricePaise: 6250, taxablePaise: 6_250_000 },
    { ...PLATE, qtyMilli: units(500), unitPricePaise: 6800, taxablePaise: 3_400_000 },
  ],
  taxablePaise: 9_650_000,
  cgstPaise: 868_500,
  sgstPaise: 868_500,
  igstPaise: null,
  roundOffPaise: null,
  totalPaise: 11_387_000,
} as const;

export const SCENARIOS: readonly FixtureScenario[] = [
  {
    id: 'S01',
    file: 'S01-clean.pdf',
    kind: 'pdf',
    title: 'Clean invoice against an existing PO and GRN',
    ...S01_BASE,
  },
  {
    id: 'S02',
    file: 'S02-apex-interstate.pdf',
    kind: 'pdf',
    title: 'Inter-state IGST; vendor item code becomes an alias',
    vendor: APEX,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'APX-7781',
    invoiceDate: '2026-09-16',
    poNumber: 'PO-2026-0103',
    lines: [
      {
        ...BEARING,
        vendorItemCode: 'BRG-6204ZZ',
        uom: 'NOS',
        qtyMilli: units(100),
        unitPricePaise: 14_500,
        taxablePaise: 1_450_000,
      },
    ],
    taxablePaise: 1_450_000,
    cgstPaise: null,
    sgstPaise: null,
    igstPaise: 261_000,
    roundOffPaise: null,
    totalPaise: 1_711_000,
  },
  {
    id: 'S03',
    file: 'S03-new-vendor.pdf',
    kind: 'pdf',
    title: 'New vendor, no PO, below the auto-PO threshold',
    vendor: {
      name: 'Nandi Stationers Pvt Ltd',
      gstin: '29AADCN9753P1ZH',
      address: '45 Chickpet Main Road, Bengaluru 560053',
    },
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'NS-0092',
    invoiceDate: '2026-09-17',
    poNumber: null,
    lines: [
      {
        description: 'A4 Copier Paper 75 GSM',
        hsnSac: '4802',
        uom: 'REAM',
        gstRateBp: 1200,
        qtyMilli: units(40),
        unitPricePaise: 24_500,
        taxablePaise: 980_000,
      },
    ],
    taxablePaise: 980_000,
    cgstPaise: 58_800,
    sgstPaise: 58_800,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 1_097_600,
  },
  {
    id: 'S04',
    file: 'S04-no-po-above-threshold.pdf',
    kind: 'pdf',
    title: 'No PO, total above the auto-PO threshold',
    vendor: EASTLINE,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'EOS/1204',
    invoiceDate: '2026-09-18',
    poNumber: null,
    lines: [{ ...TONER, qtyMilli: units(12), unitPricePaise: 245_000, taxablePaise: 2_940_000 }],
    taxablePaise: 2_940_000,
    cgstPaise: 264_600,
    sgstPaise: 264_600,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 3_469_200,
  },
  {
    id: 'S05',
    file: 'S05-new-item.pdf',
    kind: 'pdf',
    title: 'Item not in the item master',
    vendor: EASTLINE,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'EOS/1210',
    invoiceDate: '2026-09-19',
    poNumber: null,
    lines: [
      {
        description: 'Whiteboard Marker Box of 10',
        hsnSac: '9608',
        uom: 'BOX',
        gstRateBp: 1800,
        qtyMilli: units(30),
        unitPricePaise: 18_000,
        taxablePaise: 540_000,
      },
    ],
    taxablePaise: 540_000,
    cgstPaise: 48_600,
    sgstPaise: 48_600,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 637_200,
  },
  {
    id: 'S06',
    file: 'S06-po-not-in-erp.pdf',
    kind: 'pdf',
    title: 'Cites a PO number that does not exist; printed round-off',
    vendor: SHAKTI,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'SSS/26-27/0460',
    invoiceDate: '2026-09-20',
    poNumber: 'PO-2026-0199',
    lines: [{ ...ROD, qtyMilli: units(50), unitPricePaise: 6250, taxablePaise: 312_500 }],
    taxablePaise: 312_500,
    cgstPaise: 28_125,
    sgstPaise: 28_125,
    igstPaise: null,
    roundOffPaise: 50,
    totalPaise: 368_800,
  },
  {
    id: 'S07',
    file: 'S07-which-po.pdf',
    kind: 'pdf',
    title: 'No PO reference; the vendor has two open POs',
    vendor: {
      name: 'Kaveri Tools & Hardware Pvt Ltd',
      gstin: '33AAHCK1357R1Z3',
      address: 'Ambattur Industrial Estate, Chennai 600058',
    },
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'KTH-3310',
    invoiceDate: '2026-09-20',
    poNumber: null,
    lines: [
      {
        description: 'Cutting Disc 4 inch',
        hsnSac: '6804',
        uom: 'NOS',
        gstRateBp: 1800,
        qtyMilli: units(100),
        unitPricePaise: 3800,
        taxablePaise: 380_000,
      },
    ],
    taxablePaise: 380_000,
    cgstPaise: null,
    sgstPaise: null,
    igstPaise: 68_400,
    roundOffPaise: null,
    totalPaise: 448_400,
  },
  {
    id: 'S08',
    file: 'S08-missing-grn.pdf',
    kind: 'pdf',
    title: 'PO has no goods receipt',
    vendor: APEX,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'APX-7790',
    invoiceDate: '2026-09-21',
    poNumber: 'PO-2026-0104',
    lines: [
      {
        ...BEARING,
        uom: 'NOS',
        qtyMilli: units(50),
        unitPricePaise: 14_500,
        taxablePaise: 725_000,
      },
    ],
    taxablePaise: 725_000,
    cgstPaise: null,
    sgstPaise: null,
    igstPaise: 130_500,
    roundOffPaise: null,
    totalPaise: 855_500,
  },
  {
    id: 'S09',
    file: 'S09-price-differs.pdf',
    kind: 'pdf',
    title: 'Unit price one paisa above the PO',
    vendor: SHAKTI,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'SSS/26-27/0466',
    invoiceDate: '2026-09-22',
    poNumber: 'PO-2026-0109',
    lines: [{ ...PLATE, qtyMilli: units(100), unitPricePaise: 6801, taxablePaise: 680_100 }],
    taxablePaise: 680_100,
    cgstPaise: 61_209,
    sgstPaise: 61_209,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 802_518,
  },
  {
    id: 'S10',
    file: 'S10-quantity-differs.pdf',
    kind: 'pdf',
    title: 'Invoiced quantity above the quantity received',
    vendor: SHAKTI,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'SSS/26-27/0470',
    invoiceDate: '2026-09-22',
    poNumber: 'PO-2026-0102',
    lines: [{ ...ROD, qtyMilli: units(200), unitPricePaise: 6250, taxablePaise: 1_250_000 }],
    taxablePaise: 1_250_000,
    cgstPaise: 112_500,
    sgstPaise: 112_500,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 1_475_000,
  },
  {
    id: 'S11b',
    file: 'S11b-S01-photo.png',
    kind: 'photo',
    title: 'Phone photo of S01 (a business duplicate once S01 is recorded)',
    ...S01_BASE,
  },
  {
    id: 'S12',
    file: 'S12-tax-differs.pdf',
    kind: 'pdf',
    title: 'Printed CGST and SGST are 50 paise too high',
    vendor: SHAKTI,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'SSS/26-27/0475',
    invoiceDate: '2026-09-23',
    poNumber: 'PO-2026-0110',
    lines: [{ ...ROD, qtyMilli: units(100), unitPricePaise: 6250, taxablePaise: 625_000 }],
    taxablePaise: 625_000,
    cgstPaise: 56_300,
    sgstPaise: 56_300,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 737_600,
  },
  {
    id: 'S13',
    file: 'S13-wrong-tax-type.pdf',
    kind: 'pdf',
    title: 'Inter-state supply charged CGST and SGST',
    vendor: APEX,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'APX-7795',
    invoiceDate: '2026-09-23',
    poNumber: 'PO-2026-0111',
    lines: [
      {
        ...BEARING,
        uom: 'NOS',
        qtyMilli: units(20),
        unitPricePaise: 14_500,
        taxablePaise: 290_000,
      },
    ],
    taxablePaise: 290_000,
    cgstPaise: 26_100,
    sgstPaise: 26_100,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 342_200,
  },
  {
    id: 'S14',
    file: 'S14-blurry.png',
    kind: 'photo',
    title: 'Blurry photo: the total cannot be read reliably',
    vendor: SHAKTI,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'SSS/26-27/0480',
    invoiceDate: '2026-09-24',
    poNumber: 'PO-2026-0112',
    lines: [{ ...PLATE, qtyMilli: units(200), unitPricePaise: 6800, taxablePaise: 1_360_000 }],
    taxablePaise: 1_360_000,
    cgstPaise: 122_400,
    sgstPaise: 122_400,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 1_604_800,
    weak: { totalPaise: { value: 1_606_800, confidenceBp: 4100 } },
  },
  {
    id: 'S15',
    file: 'S15-invalid-gstin.pdf',
    kind: 'pdf',
    title: 'Supplier GSTIN fails its check digit',
    vendor: {
      name: 'Meridian Fasteners',
      gstin: '29AAGCM4455J1Z5',
      address: 'Whitefield, Bengaluru 560066',
    },
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'MF-221',
    invoiceDate: '2026-09-24',
    poNumber: null,
    lines: [
      {
        description: 'Hex Bolt M10 x 50',
        hsnSac: '7318',
        uom: 'NOS',
        gstRateBp: 1800,
        qtyMilli: units(500),
        unitPricePaise: 420,
        taxablePaise: 210_000,
      },
    ],
    taxablePaise: 210_000,
    cgstPaise: 18_900,
    sgstPaise: 18_900,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 247_800,
  },
  {
    id: 'S16',
    file: 'S16-inactive-vendor.pdf',
    kind: 'pdf',
    title: 'Vendor is marked inactive in the ERP',
    vendor: {
      name: 'Bharat Packaging',
      gstin: '29ABCPB2468Q1Z9',
      address: 'Bommasandra, Bengaluru 560099',
    },
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'BP-118',
    invoiceDate: '2026-09-25',
    poNumber: 'PO-2026-0107',
    lines: [
      {
        description: 'Corrugated Box 5 Ply',
        hsnSac: '4819',
        uom: 'NOS',
        gstRateBp: 1200,
        qtyMilli: units(500),
        unitPricePaise: 2400,
        taxablePaise: 1_200_000,
      },
    ],
    taxablePaise: 1_200_000,
    cgstPaise: 72_000,
    sgstPaise: 72_000,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 1_344_000,
  },
  {
    id: 'S17',
    file: 'S17-vasudha-photo.png',
    kind: 'photo',
    title: 'Photo with an unreadable GSTIN; two vendors share the name',
    vendor: {
      name: 'VASUDHA TRADERS',
      gstin: '29AAACV1234F1ZL',
      address: 'Avenue Road, Bengaluru 560002',
    },
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'VT-5520',
    invoiceDate: '2026-09-25',
    poNumber: 'PO-2026-0108',
    lines: [{ ...TONER, qtyMilli: units(10), unitPricePaise: 245_000, taxablePaise: 2_450_000 }],
    taxablePaise: 2_450_000,
    cgstPaise: 220_500,
    sgstPaise: 220_500,
    igstPaise: null,
    roundOffPaise: null,
    totalPaise: 2_891_000,
    weak: { vendorGstin: { value: '29AAACV12?4F1Z?', confidenceBp: 3500 } },
  },
  {
    id: 'S18',
    file: 'S18-closed-po.pdf',
    kind: 'pdf',
    title: 'Cites a closed PO',
    vendor: SHAKTI,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'SSS/26-27/0490',
    invoiceDate: '2026-09-26',
    poNumber: 'PO-2026-0099',
    lines: [{ ...ROD, qtyMilli: units(10), unitPricePaise: 6250, taxablePaise: 62_500 }],
    taxablePaise: 62_500,
    cgstPaise: 5_625,
    sgstPaise: 5_625,
    igstPaise: null,
    roundOffPaise: 50,
    totalPaise: 73_800,
  },
  {
    id: 'S19',
    file: 'S19-uom-differs.pdf',
    kind: 'pdf',
    title: 'Invoice unit (PCS) differs from the item master unit (NOS)',
    vendor: APEX,
    buyerGstin: DEMO_BUYER.gstin,
    placeOfSupply: KA,
    invoiceNumber: 'APX-7799',
    invoiceDate: '2026-09-26',
    poNumber: 'PO-2026-0111',
    lines: [
      {
        ...BEARING,
        uom: 'PCS',
        qtyMilli: units(20),
        unitPricePaise: 14_500,
        taxablePaise: 290_000,
      },
    ],
    taxablePaise: 290_000,
    cgstPaise: null,
    sgstPaise: null,
    igstPaise: 52_200,
    roundOffPaise: null,
    totalPaise: 342_200,
  },
];

export const scenarioById = (id: string): FixtureScenario | undefined =>
  SCENARIOS.find((s) => s.id === id);
