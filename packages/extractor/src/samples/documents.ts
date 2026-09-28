/**
 * Synthetic invoice documents for the REAL extraction path (Phase 3D), rendered by
 * `npm run fixtures:documents` into `fixtures/documents/`. Every party, number and amount is made
 * up and matches the demo ERP seed (docs/DEMO.md §1). No private or customer document is used.
 *
 * Each sample states what is PRINTED. `expect` states what the workflow must do with it; the
 * tests assert both the reading and the outcome.
 */

export interface SampleLine {
  description: string;
  code?: string;
  hsn: string;
  qty: string;
  uom: string;
  rate: string;
  disc?: string;
  gst: string;
  taxable: string;
}

export interface SampleInvoice {
  vendor: { name: string; address: string; gstin: string | null; pan?: string };
  number: string;
  date: string;
  po: string | null;
  placeOfSupply: string;
  lines: SampleLine[];
  taxable: string;
  cgst?: string;
  sgst?: string;
  igst?: string;
  roundOff?: string;
  total: string;
  /** The total is smudged: printed, but not legible (rendered as blurred ink, not text). */
  smudgedTotal?: boolean;
  /** Force the table to continue on a second page (repeated header, totals on page 2). */
  twoPages?: boolean;
}

export type SampleKind = 'text-pdf' | 'scanned-pdf' | 'jpeg' | 'png' | 'blurry-jpeg';

export interface DocumentSample {
  file: string;
  kind: SampleKind;
  title: string;
  invoices: SampleInvoice[];
  expect:
    | { state: 'VERIFIED_PENDING_PAYMENT'; questions: 'none' }
    | { state: 'NEEDS_INPUT'; firstQuestion?: string }
    | { state: 'FAILED'; reason: RegExp };
}

export const BUYER = {
  name: 'Veyra Demo Industries Pvt Ltd',
  address: 'Peenya Industrial Area, Bengaluru 560058',
  gstin: '29AAACS1111A1Z6',
  shipTo: 'Plot 7, Peenya Phase 1, Bengaluru 560058',
  state: 'Karnataka (29)',
};

const SHAKTI = {
  name: 'Shakti Steel Suppliers Pvt Ltd',
  address: 'Plot 14, Peenya 2nd Stage, Bengaluru 560058',
  gstin: '29AAFCS5678K1ZK',
  pan: 'AAFCS5678K',
};
const APEX = {
  name: 'Apex Components Pvt Ltd',
  address: 'Bhosari MIDC, Pune 411026',
  gstin: '27AAACA4321M1ZT',
  pan: 'AAACA4321M',
};
const KAVERI = {
  name: 'Kaveri Tools & Hardware Pvt Ltd',
  address: 'Ambattur Industrial Estate, Chennai 600058',
  gstin: '33AAHCK1357R1Z3',
  pan: 'AAHCK1357R',
};

const ROD = { description: 'MS Steel Rod 12mm', hsn: '7214', uom: 'KGS', gst: '18%' };
const PLATE = { description: 'MS Steel Plate 6mm', hsn: '7208', uom: 'KGS', gst: '18%' };
const BEARING = { description: 'Ball Bearing 6204 ZZ', hsn: '8482', uom: 'NOS', gst: '18%' };
const DISC = { description: 'Cutting Disc 4 inch', hsn: '6804', uom: 'NOS', gst: '18%' };
const TONER = { description: 'Printer Toner Cartridge 88A', hsn: '8443', uom: 'NOS', gst: '18%' };
const KA = 'Karnataka (29)';

export const DOCUMENT_SAMPLES: readonly DocumentSample[] = [
  {
    file: 'D01-clean-text.pdf',
    kind: 'text-pdf',
    title: 'Clean text PDF: read exactly, matched, verified with no questions',
    invoices: [
      {
        vendor: SHAKTI,
        number: 'SSS/26-27/0501',
        date: '27/09/2026',
        po: 'PO-2026-0110',
        placeOfSupply: KA,
        lines: [
          {
            ...ROD,
            code: 'SR-12',
            qty: '100.000',
            rate: '62.50',
            disc: '0.00',
            taxable: '6,250.00',
          },
        ],
        taxable: '6,250.00',
        cgst: '562.50',
        sgst: '562.50',
        roundOff: '0.00',
        total: '7,375.00',
      },
    ],
    expect: { state: 'VERIFIED_PENDING_PAYMENT', questions: 'none' },
  },
  {
    file: 'D02-scanned.pdf',
    kind: 'scanned-pdf',
    title: 'Scanned PDF (image only): read by OCR',
    invoices: [
      {
        vendor: APEX,
        number: 'APX-7801',
        date: '27/09/2026',
        po: 'PO-2026-0103',
        placeOfSupply: KA,
        lines: [{ ...BEARING, qty: '100', rate: '145.00', taxable: '14,500.00' }],
        taxable: '14,500.00',
        igst: '2,610.00',
        total: '17,110.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT' },
  },
  {
    file: 'D03-photo.jpg',
    kind: 'jpeg',
    title: 'JPEG invoice: read by OCR',
    invoices: [
      {
        vendor: KAVERI,
        number: 'KTH-3320',
        date: '26/09/2026',
        po: 'PO-2026-0105',
        placeOfSupply: KA,
        lines: [{ ...DISC, qty: '200', rate: '38.00', taxable: '7,600.00' }],
        taxable: '7,600.00',
        igst: '1,368.00',
        total: '8,968.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT' },
  },
  {
    file: 'D04-photo.png',
    kind: 'png',
    title: 'PNG invoice: read by OCR',
    invoices: [
      {
        vendor: SHAKTI,
        number: 'SSS/26-27/0505',
        date: '26/09/2026',
        po: 'PO-2026-0109',
        placeOfSupply: KA,
        lines: [{ ...PLATE, qty: '100.000', rate: '68.00', taxable: '6,800.00' }],
        taxable: '6,800.00',
        cgst: '612.00',
        sgst: '612.00',
        total: '8,024.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT' },
  },
  {
    file: 'D05-blurry.jpg',
    kind: 'blurry-jpeg',
    title: 'Blurry photo: unclear values are asked, never guessed',
    invoices: [
      {
        vendor: SHAKTI,
        number: 'SSS/26-27/0512',
        date: '25/09/2026',
        po: 'PO-2026-0112',
        placeOfSupply: KA,
        lines: [{ ...PLATE, qty: '200.000', rate: '68.00', taxable: '13,600.00' }],
        taxable: '13,600.00',
        cgst: '1,224.00',
        sgst: '1,224.00',
        total: '16,048.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT' },
  },
  {
    file: 'D06-unreadable-total.pdf',
    kind: 'text-pdf',
    title: 'Total smudged: the total is asked; everything else is read exactly',
    invoices: [
      {
        vendor: SHAKTI,
        number: 'SSS/26-27/0515',
        date: '26/09/2026',
        po: 'PO-2026-0102',
        placeOfSupply: KA,
        lines: [{ ...ROD, qty: '180.000', rate: '62.50', taxable: '11,250.00' }],
        taxable: '11,250.00',
        cgst: '1,012.50',
        sgst: '1,012.50',
        total: '13,275.00',
        smudgedTotal: true,
      },
    ],
    expect: { state: 'NEEDS_INPUT', firstQuestion: 'MD_FIELD' },
  },
  {
    file: 'D07-quantity-mismatch.pdf',
    kind: 'text-pdf',
    title: 'Quantity above what the PO allows: deterministic check, asked',
    invoices: [
      {
        vendor: KAVERI,
        number: 'KTH-3325',
        date: '26/09/2026',
        po: 'PO-2026-0106',
        placeOfSupply: KA,
        lines: [{ ...DISC, qty: '120', rate: '38.00', taxable: '4,560.00' }],
        taxable: '4,560.00',
        igst: '820.80',
        total: '5,380.80',
      },
    ],
    expect: { state: 'NEEDS_INPUT', firstQuestion: 'VF_R23' },
  },
  {
    file: 'D08-rate-mismatch.pdf',
    kind: 'text-pdf',
    title: 'Price differs from the PO: deterministic check, asked',
    invoices: [
      {
        vendor: APEX,
        number: 'APX-7805',
        date: '26/09/2026',
        po: 'PO-2026-0111',
        placeOfSupply: KA,
        lines: [{ ...BEARING, qty: '20', rate: '150.00', taxable: '3,000.00' }],
        taxable: '3,000.00',
        igst: '540.00',
        total: '3,540.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT', firstQuestion: 'VF_R21' },
  },
  {
    file: 'D09-ambiguous-vendor.pdf',
    kind: 'text-pdf',
    title: 'No GSTIN printed and two suppliers share the name: asked, never auto-linked',
    invoices: [
      {
        vendor: { name: 'Vasudha Traders', address: 'Chickpet, Bengaluru 560053', gstin: null },
        number: 'VT-5530',
        date: '26/09/2026',
        po: 'PO-2026-0108',
        placeOfSupply: KA,
        lines: [{ ...TONER, qty: '10', rate: '2,450.00', taxable: '24,500.00' }],
        taxable: '24,500.00',
        cgst: '2,205.00',
        sgst: '2,205.00',
        total: '28,910.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT', firstQuestion: 'AM_VENDOR' },
  },
  {
    file: 'D10-multi-page.pdf',
    kind: 'text-pdf',
    title: 'One invoice over two pages: lines and totals read across pages',
    invoices: [
      {
        vendor: SHAKTI,
        number: 'SSS/26-27/0520',
        date: '27/09/2026',
        po: 'PO-2026-0101',
        placeOfSupply: KA,
        lines: [
          { ...ROD, qty: '1,000.000', rate: '62.50', taxable: '62,500.00' },
          { ...PLATE, qty: '500.000', rate: '68.00', taxable: '34,000.00' },
        ],
        taxable: '96,500.00',
        cgst: '8,685.00',
        sgst: '8,685.00',
        total: '1,13,870.00',
        twoPages: true,
      },
    ],
    expect: { state: 'VERIFIED_PENDING_PAYMENT', questions: 'none' },
  },
  {
    file: 'D12-missing-receipt.pdf',
    kind: 'text-pdf',
    title: 'No goods receipt recorded for the order: Veyra asks whether the goods arrived',
    invoices: [
      {
        vendor: APEX,
        number: 'APX-7812',
        date: '27/09/2026',
        po: 'PO-2026-0104',
        placeOfSupply: KA,
        lines: [{ ...BEARING, qty: '50', rate: '145.00', taxable: '7,250.00' }],
        taxable: '7,250.00',
        igst: '1,305.00',
        total: '8,555.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT', firstQuestion: 'CA_GRN' },
  },
  {
    file: 'D11-two-invoices.pdf',
    kind: 'text-pdf',
    title: 'Two invoices in one file: never merged; fails visibly and asks for separate files',
    invoices: [
      {
        vendor: SHAKTI,
        number: 'SSS/26-27/0530',
        date: '27/09/2026',
        po: 'PO-2026-0110',
        placeOfSupply: KA,
        lines: [{ ...ROD, qty: '10.000', rate: '62.50', taxable: '625.00' }],
        taxable: '625.00',
        cgst: '56.25',
        sgst: '56.25',
        roundOff: '0.50',
        total: '738.00',
      },
      {
        vendor: SHAKTI,
        number: 'SSS/26-27/0531',
        date: '27/09/2026',
        po: 'PO-2026-0110',
        placeOfSupply: KA,
        lines: [{ ...ROD, qty: '20.000', rate: '62.50', taxable: '1,250.00' }],
        taxable: '1,250.00',
        cgst: '112.50',
        sgst: '112.50',
        total: '1,475.00',
      },
    ],
    expect: { state: 'FAILED', reason: /more than one invoice/ },
  },
];
