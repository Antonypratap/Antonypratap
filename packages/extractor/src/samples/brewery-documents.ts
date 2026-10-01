/**
 * The brewery demo's invoices (docs/DEMO.md §10), rendered by `npm run fixtures:documents` into
 * `fixtures/documents/brewery/`. Every party, number and amount is made up and matches the brewery
 * ERP seed (`@veyra/fake-erp`, seed/brewery-data.ts). One document per demo scenario.
 */
import type { DocumentSample, SampleBuyer } from './documents';

export const BREWERY_BUYER: SampleBuyer = {
  name: 'Hopsmith Brewing Co. Pvt Ltd',
  address: 'Survey No. 48, Whitefield Main Road, Bengaluru 560066',
  gstin: '29AAICH4826L1Z2',
  shipTo: 'Brewhouse, Survey No. 48, Whitefield, Bengaluru 560066',
  state: 'Karnataka (29)',
};

const MALABAR = {
  name: 'Malabar Malt House Pvt Ltd',
  address: 'Plot 22, KIADB Industrial Area, Doddaballapur 561203',
  gstin: '29AABCM2468K1Z4',
  pan: 'AABCM2468K',
};
const HIMALAYAN = {
  name: 'Himalayan Hop Traders Pvt Ltd',
  address: 'Industrial Area Phase 2, Baddi, Himachal Pradesh 173205',
  gstin: '02AAECH1357P1ZI',
  pan: 'AAECH1357P',
};
const COROMANDEL = {
  name: 'Coromandel Crown Closures Pvt Ltd',
  address: 'SIDCO Industrial Estate, Hosur 635126',
  gstin: '33AAHCC8642R1Z1',
  pan: 'AAHCC8642R',
};

const PILSNER = { description: 'Pilsner Malt', hsn: '1107', uom: 'KGS', gst: '18%' };
const MUNICH = { description: 'Munich Malt', hsn: '1107', uom: 'KGS', gst: '18%' };
const HOPS = { description: 'Cascade Hop Pellets', hsn: '1210', uom: 'KGS', gst: '5%' };
const CROWN = { description: 'Crown Cork 26 mm', hsn: '8309', uom: 'NOS', gst: '18%' };
const CARTON = {
  description: 'Corrugated Carton 24 x 330 ml',
  hsn: '4819',
  uom: 'NOS',
  gst: '18%',
};
const KA = 'Karnataka (29)';

const sample = (s: Omit<DocumentSample, 'buyer'>): DocumentSample => ({
  ...s,
  buyer: BREWERY_BUYER,
});

export const BREWERY_DOCUMENT_SAMPLES: readonly DocumentSample[] = [
  sample({
    file: 'brewery/B01-clean.pdf',
    kind: 'text-pdf',
    title: 'Clean malt invoice: read exactly, matched, verified with no questions',
    invoices: [
      {
        vendor: MALABAR,
        number: 'MMH/26-27/0412',
        date: '27/09/2026',
        po: 'PO-2026-1103',
        placeOfSupply: KA,
        lines: [
          {
            ...PILSNER,
            code: 'PM-25',
            qty: '1,000.000',
            rate: '58.00',
            disc: '0.00',
            taxable: '58,000.00',
          },
        ],
        taxable: '58,000.00',
        cgst: '5,220.00',
        sgst: '5,220.00',
        roundOff: '0.00',
        total: '68,440.00',
      },
    ],
    expect: { state: 'VERIFIED_PENDING_PAYMENT', questions: 'none' },
  }),
  sample({
    file: 'brewery/B02-missing-receipt.pdf',
    kind: 'text-pdf',
    title: 'Hops ordered, no goods receipt recorded: Veyrafy asks whether the goods arrived',
    invoices: [
      {
        vendor: HIMALAYAN,
        number: 'HHT-2291',
        date: '27/09/2026',
        po: 'PO-2026-1105',
        placeOfSupply: KA,
        lines: [{ ...HOPS, qty: '20.000', rate: '1,450.00', taxable: '29,000.00' }],
        taxable: '29,000.00',
        igst: '1,450.00',
        total: '30,450.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT', firstQuestion: 'CA_GRN' },
  }),
  sample({
    file: 'brewery/B03-ambiguous-supplier.pdf',
    kind: 'text-pdf',
    title: 'No GSTIN, and two suppliers share the name: Veyrafy asks which one',
    invoices: [
      {
        vendor: {
          name: 'Kaveri Cartons',
          address: 'Peenya 2nd Stage, Bengaluru 560058',
          gstin: null,
        },
        number: 'KC-0784',
        date: '27/09/2026',
        po: 'PO-2026-1108',
        placeOfSupply: KA,
        lines: [{ ...CARTON, qty: '2,000', rate: '18.50', taxable: '37,000.00' }],
        taxable: '37,000.00',
        cgst: '3,330.00',
        sgst: '3,330.00',
        total: '43,660.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT', firstQuestion: 'AM_VENDOR' },
  }),
  sample({
    file: 'brewery/B04-quantity-mismatch.pdf',
    kind: 'text-pdf',
    title: '24,000 crown corks billed against an order of 20,000: Veyrafy stops',
    invoices: [
      {
        vendor: COROMANDEL,
        number: 'CCC-5530',
        date: '27/09/2026',
        po: 'PO-2026-1107',
        placeOfSupply: KA,
        lines: [{ ...CROWN, qty: '24,000', rate: '0.45', taxable: '10,800.00' }],
        taxable: '10,800.00',
        igst: '1,944.00',
        total: '12,744.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT', firstQuestion: 'VF_R23' },
  }),
  sample({
    file: 'brewery/B05-rate-mismatch.pdf',
    kind: 'text-pdf',
    title: 'Hops billed at ₹1,520.00 per kg against an order at ₹1,450.00: Veyrafy shows both',
    invoices: [
      {
        vendor: HIMALAYAN,
        number: 'HHT-2297',
        date: '27/09/2026',
        po: 'PO-2026-1106',
        placeOfSupply: KA,
        lines: [{ ...HOPS, qty: '10.000', rate: '1,520.00', taxable: '15,200.00' }],
        taxable: '15,200.00',
        igst: '760.00',
        total: '15,960.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT', firstQuestion: 'VF_R21' },
  }),
  sample({
    file: 'brewery/B06-photo.png',
    kind: 'png',
    title: 'Phone photo of a malt invoice, read by OCR: Veyrafy asks to confirm what it read',
    invoices: [
      {
        vendor: MALABAR,
        number: 'MMH/26-27/0418',
        date: '27/09/2026',
        po: 'PO-2026-1109',
        placeOfSupply: KA,
        lines: [{ ...MUNICH, qty: '300.000', rate: '64.00', taxable: '19,200.00' }],
        taxable: '19,200.00',
        cgst: '1,728.00',
        sgst: '1,728.00',
        total: '22,656.00',
      },
    ],
    expect: { state: 'NEEDS_INPUT' },
  }),
  sample({
    file: 'brewery/B07-two-invoices.pdf',
    kind: 'text-pdf',
    title: 'Two malt invoices in one file: never merged; asks for separate files',
    invoices: [
      {
        vendor: MALABAR,
        number: 'MMH/26-27/0425',
        date: '27/09/2026',
        po: 'PO-2026-1110',
        placeOfSupply: KA,
        lines: [{ ...PILSNER, qty: '40.000', rate: '58.00', taxable: '2,320.00' }],
        taxable: '2,320.00',
        cgst: '208.80',
        sgst: '208.80',
        roundOff: '0.40',
        total: '2,738.00',
      },
      {
        vendor: MALABAR,
        number: 'MMH/26-27/0426',
        date: '27/09/2026',
        po: 'PO-2026-1110',
        placeOfSupply: KA,
        lines: [{ ...PILSNER, qty: '60.000', rate: '58.00', taxable: '3,480.00' }],
        taxable: '3,480.00',
        cgst: '313.20',
        sgst: '313.20',
        total: '4,106.40',
      },
    ],
    expect: { state: 'FAILED', reason: /more than one invoice/ },
  }),
];
