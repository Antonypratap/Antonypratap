/**
 * Demo invoices for the product prototype, taken from the scenarios in docs/DEMO.md §2.
 * Amounts are computed with @veyra/india-tax exactly as the real rules will compute them.
 * Everything here is illustrative: no extraction or workflow runs behind it.
 */
import { formatQty, milliQty, paise, rateBp, sumPaise, type Paise } from '@veyra/shared';
import { computeTax, lineTaxableAmount, type SupplyType } from '@veyra/india-tax';
import { COMPANY, vendorByCode } from './erp';

export type Outcome = 'ready' | 'processing' | 'rejected';

export interface DemoOption {
  id: string;
  label: string;
  outcome: Outcome;
  /** What the confirmation says once chosen. */
  result: string;
  emphasis: 'primary' | 'secondary' | 'quiet';
}

export interface DemoQuestion {
  /** Short issue label for queues ("Quantity differs"). */
  summary: string;
  /** One line of evidence for queues ("200 kg invoiced · 180 kg received"). */
  evidence: string;
  /** The question as the review screen states it. */
  headline: string;
  facts: readonly { label: string; value: string; tone?: 'attention' }[];
  /** "Why is this flagged?" in plain language. */
  why: readonly string[];
  options: readonly DemoOption[];
  /** How long the question has been waiting. */
  waiting: string;
}

export interface DemoLine {
  description: string;
  hsn: string;
  qtyMilli: number;
  uom: string;
  unitPricePaise: number;
  rateBp: number;
}

export interface DemoParty {
  name: string;
  gstin: string | null;
  address: string;
  state: string;
  stateCode: string;
}

export interface DemoInvoice {
  id: string;
  scenario: string;
  number: string;
  supplier: DemoParty;
  date: string;
  poNumber: string | null;
  source: 'PDF' | 'Photo';
  receivedLabel: string;
  lines: readonly DemoLine[];
  supply: SupplyType;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  roundOffPaise: Paise | null;
  totalPaise: Paise;
  initialStatus: 'attention' | 'handled';
  /** For handled invoices: a short note on what Veyra did. */
  handledNote?: string;
  question?: DemoQuestion;
}

const STATE_ADDR: Record<string, { address: string; code: string }> = {
  Karnataka: { address: 'Peenya Industrial Area, Bengaluru 560058', code: '29' },
  Maharashtra: { address: 'Bhosari MIDC, Pune 411026', code: '27' },
  'Tamil Nadu': { address: 'Ambattur Industrial Estate, Chennai 600058', code: '33' },
};

function supplier(code: string): DemoParty {
  const v = vendorByCode(code);
  if (!v) throw new Error(`unknown vendor ${code}`);
  const place = STATE_ADDR[v.state];
  if (!place) throw new Error(`no address for ${v.state}`);
  return {
    name: v.name,
    gstin: v.gstin,
    address: place.address,
    state: v.state,
    stateCode: place.code,
  };
}

const kg = (n: number): number => n * 1000;

interface Spec extends Omit<
  DemoInvoice,
  | 'supply'
  | 'taxablePaise'
  | 'cgstPaise'
  | 'sgstPaise'
  | 'igstPaise'
  | 'totalPaise'
  | 'roundOffPaise'
> {
  /** Tax exactly as printed, when the invoice prints something other than the correct figure. */
  printedTax?: { cgst: number; sgst: number; igst: number };
  roundOffPaise?: number;
}

function build(spec: Spec): DemoInvoice {
  const supply: SupplyType = spec.supplier.stateCode === '29' ? 'intra_state' : 'inter_state';
  const taxable = spec.lines.map((l) =>
    lineTaxableAmount(milliQty(l.qtyMilli), paise(l.unitPricePaise)),
  );
  const taxes = spec.lines.map((l, i) =>
    computeTax(taxable[i] ?? paise(0), rateBp(l.rateBp), supply),
  );
  const computed = {
    cgst: sumPaise(taxes.map((t) => t.cgstPaise)),
    sgst: sumPaise(taxes.map((t) => t.sgstPaise)),
    igst: sumPaise(taxes.map((t) => t.igstPaise)),
  };
  const { printedTax, roundOffPaise, ...rest } = spec;
  const printed = printedTax
    ? { cgst: paise(printedTax.cgst), sgst: paise(printedTax.sgst), igst: paise(printedTax.igst) }
    : computed;
  const taxablePaise = sumPaise(taxable);
  const roundOff = roundOffPaise === undefined ? null : paise(roundOffPaise);
  const totalPaise = sumPaise([
    taxablePaise,
    printed.cgst,
    printed.sgst,
    printed.igst,
    roundOff ?? paise(0),
  ]);
  return {
    ...rest,
    supply,
    taxablePaise,
    cgstPaise: printed.cgst,
    sgstPaise: printed.sgst,
    igstPaise: printed.igst,
    roundOffPaise: roundOff,
    totalPaise,
  };
}

const ROD = { description: 'MS Steel Rod 12mm', hsn: '7214', uom: 'KGS', rateBp: 1800 };
const PLATE = { description: 'MS Steel Plate 6mm', hsn: '7208', uom: 'KGS', rateBp: 1800 };
const BEARING = { description: 'Ball Bearing 6204 ZZ', hsn: '8482', uom: 'NOS', rateBp: 1800 };
const TONER = { description: 'Printer Toner Cartridge 88A', hsn: '8443', uom: 'NOS', rateBp: 1800 };

const reject = (label: string, result: string): DemoOption => ({
  id: 'reject',
  label,
  outcome: 'rejected',
  result,
  emphasis: 'secondary',
});

/** Needs attention, in the order the queue shows them (oldest question last). */
const ATTENTION: DemoInvoice[] = [
  build({
    id: 's10',
    scenario: 'S10',
    number: 'SSS/26-27/0470',
    supplier: supplier('V001'),
    date: '2026-09-22',
    poNumber: 'PO-2026-0102',
    source: 'PDF',
    receivedLabel: 'Today, 08:12',
    lines: [{ ...ROD, qtyMilli: kg(200), unitPricePaise: 6250 }],
    initialStatus: 'attention',
    question: {
      summary: 'Quantity differs',
      evidence: '200 kg invoiced · 180 kg received',
      headline: 'The invoice is for more steel rod than was received.',
      facts: [
        { label: 'Invoice quantity', value: '200 kg' },
        { label: 'Received', value: '180 kg' },
        { label: 'Difference', value: '20 kg', tone: 'attention' },
      ],
      why: [
        'The invoice bills 200 kg of MS Steel Rod 12mm against PO-2026-0102.',
        'The goods receipt for that order records 180 kg received.',
        'Everything else on the invoice matches the order.',
      ],
      options: [
        {
          id: 'accept',
          label: 'Accept 180 kg',
          outcome: 'ready',
          result: 'Accepted for the 180 kg received.',
          emphasis: 'primary',
        },
        reject('Ask the supplier', 'Returned to Shakti Steel Suppliers to correct the quantity.'),
        {
          id: 'receipt',
          label: 'The other 20 kg arrived. Record it',
          outcome: 'ready',
          result: 'Receipt of the remaining 20 kg recorded.',
          emphasis: 'quiet',
        },
      ],
      waiting: '12 min',
    },
  }),
  build({
    id: 's14',
    scenario: 'S14',
    number: 'SSS/26-27/0480',
    supplier: supplier('V001'),
    date: '2026-09-24',
    poNumber: 'PO-2026-0112',
    source: 'Photo',
    receivedLabel: 'Today, 07:55',
    lines: [{ ...PLATE, qtyMilli: kg(200), unitPricePaise: 6800 }],
    initialStatus: 'attention',
    question: {
      summary: 'Total unclear',
      evidence: 'The photo is blurred around the total',
      headline: 'The total on this photo couldn’t be read clearly.',
      facts: [
        { label: 'Calculated from the lines', value: '₹16,048.00' },
        { label: 'Readable on the photo', value: '₹16,0?8.00', tone: 'attention' },
      ],
      why: [
        'The invoice was sent as a phone photo and the total is blurred.',
        'Veyra does not fill in figures it cannot read.',
      ],
      options: [
        {
          id: 'confirm',
          label: 'Confirm ₹16,048.00',
          outcome: 'ready',
          result: 'Total confirmed as ₹16,048.00.',
          emphasis: 'primary',
        },
        reject('Ask for a clearer copy', 'Asked Shakti Steel Suppliers for a clearer copy.'),
      ],
      waiting: '29 min',
    },
  }),
  build({
    id: 's17',
    scenario: 'S17',
    number: 'VT-5520',
    supplier: {
      name: 'VASUDHA TRADERS',
      gstin: null,
      address: 'Bengaluru',
      state: 'Karnataka',
      stateCode: '29',
    },
    date: '2026-09-25',
    poNumber: 'PO-2026-0108',
    source: 'Photo',
    receivedLabel: 'Today, 07:40',
    lines: [{ ...TONER, qtyMilli: kg(10), unitPricePaise: 245000 }],
    initialStatus: 'attention',
    question: {
      summary: 'Which supplier?',
      evidence: 'Two suppliers are called Vasudha Traders',
      headline: 'Two of your suppliers are called Vasudha Traders.',
      facts: [
        { label: 'Vasudha Traders', value: '29AAACV1234F1ZL' },
        { label: 'Vasudha Traders & Co', value: '29AAJFV2222B1ZG' },
        { label: 'GSTIN on the photo', value: 'Not readable', tone: 'attention' },
      ],
      why: [
        'The GSTIN on the photo cannot be read.',
        'Veyra never picks a supplier by name alone.',
      ],
      options: [
        {
          id: 'v005',
          label: 'Vasudha Traders',
          outcome: 'ready',
          result: 'Supplier set to Vasudha Traders. It matches PO-2026-0108.',
          emphasis: 'primary',
        },
        {
          id: 'v006',
          label: 'Vasudha Traders & Co',
          outcome: 'processing',
          result: 'Supplier set to Vasudha Traders & Co. Veyra is checking it again.',
          emphasis: 'secondary',
        },
      ],
      waiting: '44 min',
    },
  }),
  build({
    id: 's09',
    scenario: 'S09',
    number: 'SSS/26-27/0466',
    supplier: supplier('V001'),
    date: '2026-09-22',
    poNumber: 'PO-2026-0109',
    source: 'PDF',
    receivedLabel: 'Today, 07:31',
    lines: [{ ...PLATE, qtyMilli: kg(100), unitPricePaise: 6801 }],
    initialStatus: 'attention',
    question: {
      summary: 'Price differs',
      evidence: '₹68.01 per kg · order says ₹68.00',
      headline: 'The price is one paisa per kg higher than the order.',
      facts: [
        { label: 'Invoice price', value: '₹68.01 / kg' },
        { label: 'Order price', value: '₹68.00 / kg' },
        { label: 'Difference on 100 kg', value: '₹1.00', tone: 'attention' },
      ],
      why: [
        'PO-2026-0109 agreed ₹68.00 per kg of MS Steel Plate 6mm.',
        'Veyra has no tolerance: even one paisa is a difference.',
      ],
      options: [
        {
          ...reject(
            'Ask for a corrected invoice',
            'Returned to Shakti Steel Suppliers for a corrected invoice.',
          ),
          emphasis: 'primary',
        },
        {
          id: 'recheck',
          label: 'The order was updated. Check again',
          outcome: 'processing',
          result: 'Veyra is checking the invoice against the updated order.',
          emphasis: 'secondary',
        },
      ],
      waiting: '1 h',
    },
  }),
  build({
    id: 's08',
    scenario: 'S08',
    number: 'APX-7790',
    supplier: supplier('V002'),
    date: '2026-09-21',
    poNumber: 'PO-2026-0104',
    source: 'PDF',
    receivedLabel: 'Today, 07:02',
    lines: [{ ...BEARING, qtyMilli: kg(50), unitPricePaise: 14500 }],
    initialStatus: 'attention',
    question: {
      summary: 'Receipt not recorded',
      evidence: 'No goods receipt for PO-2026-0104 yet',
      headline: 'Have the 50 ball bearings arrived?',
      facts: [
        { label: 'Ordered on PO-2026-0104', value: '50 NOS' },
        { label: 'Invoiced', value: '50 NOS' },
        { label: 'Recorded as received', value: 'None yet', tone: 'attention' },
      ],
      why: [
        'No goods receipt has been recorded for this order.',
        'Only a person can confirm that goods arrived.',
      ],
      options: [
        {
          id: 'received',
          label: 'Yes, all 50 arrived',
          outcome: 'ready',
          result: 'Receipt of 50 NOS recorded.',
          emphasis: 'primary',
        },
        reject('Not yet', 'On hold until the goods arrive.'),
      ],
      waiting: '1 h',
    },
  }),
  build({
    id: 's07',
    scenario: 'S07',
    number: 'KTH-3310',
    supplier: supplier('V004'),
    date: '2026-09-20',
    poNumber: null,
    source: 'PDF',
    receivedLabel: 'Today, 06:48',
    lines: [
      {
        description: 'Cutting Disc 4 inch',
        hsn: '6804',
        uom: 'NOS',
        rateBp: 1800,
        qtyMilli: kg(100),
        unitPricePaise: 3800,
      },
    ],
    initialStatus: 'attention',
    question: {
      summary: 'Which order?',
      evidence: 'Two open orders could match',
      headline: 'Which purchase order is this invoice for?',
      facts: [
        { label: 'PO-2026-0105 · 5 Sep', value: '200 NOS' },
        { label: 'PO-2026-0106 · 6 Sep', value: '100 NOS' },
        { label: 'This invoice', value: '100 NOS', tone: 'attention' },
      ],
      why: [
        'The invoice does not mention a purchase order.',
        'Kaveri Tools has two open orders for cutting discs at the same price.',
      ],
      options: [
        {
          id: 'po106',
          label: 'PO-2026-0106',
          outcome: 'ready',
          result: 'Matched to PO-2026-0106.',
          emphasis: 'primary',
        },
        {
          id: 'po105',
          label: 'PO-2026-0105',
          outcome: 'ready',
          result: 'Matched to PO-2026-0105.',
          emphasis: 'secondary',
        },
      ],
      waiting: '2 h',
    },
  }),
  build({
    id: 's16',
    scenario: 'S16',
    number: 'BP-118',
    supplier: supplier('V003'),
    date: '2026-09-25',
    poNumber: 'PO-2026-0107',
    source: 'PDF',
    receivedLabel: 'Yesterday, 17:20',
    lines: [
      {
        description: 'Corrugated Box 5 Ply',
        hsn: '4819',
        uom: 'NOS',
        rateBp: 1200,
        qtyMilli: kg(500),
        unitPricePaise: 2400,
      },
    ],
    initialStatus: 'attention',
    question: {
      summary: 'Inactive supplier',
      evidence: 'Bharat Packaging is marked inactive',
      headline: 'Bharat Packaging is marked inactive in your records.',
      facts: [
        { label: 'Supplier status', value: 'Inactive', tone: 'attention' },
        { label: 'Order PO-2026-0107', value: 'Open' },
        { label: 'Goods received', value: '500 NOS' },
      ],
      why: ['Invoices from inactive suppliers are never accepted automatically.'],
      options: [
        {
          id: 'reactivate',
          label: 'Reactivate and continue',
          outcome: 'ready',
          result: 'Bharat Packaging reactivated.',
          emphasis: 'primary',
        },
        reject('Reject this invoice', 'Invoice rejected.'),
      ],
      waiting: 'Yesterday',
    },
  }),
  build({
    id: 's04',
    scenario: 'S04',
    number: 'EOS/1204',
    supplier: supplier('V007'),
    date: '2026-09-18',
    poNumber: null,
    source: 'PDF',
    receivedLabel: 'Yesterday, 16:05',
    lines: [{ ...TONER, qtyMilli: kg(12), unitPricePaise: 245000 }],
    initialStatus: 'attention',
    question: {
      summary: 'No purchase order',
      evidence: 'Above your ₹25,000 limit for creating one',
      headline: 'There is no purchase order for this invoice.',
      facts: [
        { label: 'Invoice total', value: '₹34,692.00' },
        {
          label: 'Your limit for creating orders from invoices',
          value: '₹25,000.00',
          tone: 'attention',
        },
      ],
      why: [
        'Eastline has no open purchase order for printer toner.',
        'Above your limit, Veyra asks before creating one.',
      ],
      options: [
        {
          id: 'create',
          label: 'Create a purchase order',
          outcome: 'processing',
          result:
            'Purchase order will be created from this invoice. Veyra will ask you to confirm the goods arrived.',
          emphasis: 'primary',
        },
        reject('Reject this invoice', 'Invoice rejected.'),
      ],
      waiting: 'Yesterday',
    },
  }),
  build({
    id: 's12',
    scenario: 'S12',
    number: 'SSS/26-27/0475',
    supplier: supplier('V001'),
    date: '2026-09-23',
    poNumber: 'PO-2026-0110',
    source: 'PDF',
    receivedLabel: 'Yesterday, 15:47',
    lines: [{ ...ROD, qtyMilli: kg(100), unitPricePaise: 6250 }],
    printedTax: { cgst: 56300, sgst: 56300, igst: 0 },
    initialStatus: 'attention',
    question: {
      summary: 'Tax doesn’t add up',
      evidence: 'CGST and SGST are ₹0.50 too high',
      headline: 'The tax on this invoice is ₹1.00 more than it should be.',
      facts: [
        { label: 'CGST printed', value: '₹563.00' },
        { label: 'CGST at 9% of ₹6,250.00', value: '₹562.50' },
        { label: 'Over-charged (CGST + SGST)', value: '₹1.00', tone: 'attention' },
      ],
      why: [
        '9% of ₹6,250.00 is ₹562.50 each for CGST and SGST.',
        'The invoice prints ₹563.00 for both.',
      ],
      options: [
        {
          ...reject(
            'Ask for a corrected invoice',
            'Returned to Shakti Steel Suppliers for a corrected invoice.',
          ),
          emphasis: 'primary',
        },
        reject('Reject this invoice', 'Invoice rejected.'),
      ],
      waiting: 'Yesterday',
    },
  }),
  build({
    id: 's15',
    scenario: 'S15',
    number: 'MF-221',
    supplier: {
      name: 'Meridian Fasteners',
      gstin: '29AAGCM4455J1Z5',
      address: 'Whitefield, Bengaluru 560066',
      state: 'Karnataka',
      stateCode: '29',
    },
    date: '2026-09-24',
    poNumber: null,
    source: 'PDF',
    receivedLabel: '2 days ago',
    lines: [
      {
        description: 'Hex Bolt M10 x 50',
        hsn: '7318',
        uom: 'NOS',
        rateBp: 1800,
        qtyMilli: kg(500),
        unitPricePaise: 420,
      },
    ],
    initialStatus: 'attention',
    question: {
      summary: 'GSTIN not valid',
      evidence: 'The check digit doesn’t match',
      headline: 'Meridian Fasteners’ GSTIN is not a valid number.',
      facts: [
        { label: 'GSTIN on the invoice', value: '29AAGCM4455J1Z5', tone: 'attention' },
        { label: 'Supplier in your records', value: 'Not found' },
      ],
      why: [
        'The last character of a GSTIN is a check digit. For this number it should be 2, not 5.',
        'Veyra won’t add a new supplier with an invalid GSTIN.',
      ],
      options: [
        {
          ...reject('Ask the supplier', 'Asked Meridian Fasteners to confirm their GSTIN.'),
          emphasis: 'primary',
        },
        reject('Reject this invoice', 'Invoice rejected.'),
      ],
      waiting: '2 days',
    },
  }),
  build({
    id: 's11b',
    scenario: 'S11b',
    number: 'SSS/26-27/0451',
    supplier: supplier('V001'),
    date: '2026-09-15',
    poNumber: 'PO-2026-0101',
    source: 'Photo',
    receivedLabel: '2 days ago',
    lines: [
      { ...ROD, qtyMilli: kg(1000), unitPricePaise: 6250 },
      { ...PLATE, qtyMilli: kg(500), unitPricePaise: 6800 },
    ],
    initialStatus: 'attention',
    question: {
      summary: 'Possible duplicate',
      evidence: 'Same invoice recorded on 15 Sep',
      headline: 'This invoice has already been recorded.',
      facts: [
        { label: 'Invoice number', value: 'SSS/26-27/0451' },
        { label: 'First recorded', value: '15 Sep, as a PDF' },
        { label: 'This copy', value: 'A phone photo', tone: 'attention' },
      ],
      why: [
        'Shakti Steel Suppliers, invoice SSS/26-27/0451, financial year 2026-27, is already recorded.',
        'Paying it twice is the risk.',
      ],
      options: [{ ...reject('Reject the duplicate', 'Duplicate rejected.'), emphasis: 'primary' }],
      waiting: '2 days',
    },
  }),
];

const HANDLED: DemoInvoice[] = [
  build({
    id: 's05',
    scenario: 'S05',
    number: 'EOS/1210',
    supplier: supplier('V007'),
    date: '2026-09-19',
    poNumber: null,
    source: 'PDF',
    receivedLabel: 'Today, 08:20',
    lines: [
      {
        description: 'Whiteboard Marker Box of 10',
        hsn: '9608',
        uom: 'BOX',
        rateBp: 1800,
        qtyMilli: kg(30),
        unitPricePaise: 18000,
      },
    ],
    initialStatus: 'handled',
    handledNote: 'New item added, order created',
  }),
  build({
    id: 's03',
    scenario: 'S03',
    number: 'NS-0092',
    supplier: {
      name: 'Nandi Stationers Pvt Ltd',
      gstin: '29AADCN9753P1ZH',
      address: 'Rajajinagar, Bengaluru 560010',
      state: 'Karnataka',
      stateCode: '29',
    },
    date: '2026-09-17',
    poNumber: null,
    source: 'PDF',
    receivedLabel: 'Today, 08:04',
    lines: [
      {
        description: 'A4 Copier Paper 75 GSM',
        hsn: '4802',
        uom: 'REAM',
        rateBp: 1200,
        qtyMilli: kg(40),
        unitPricePaise: 24500,
      },
    ],
    initialStatus: 'handled',
    handledNote: 'New supplier added',
  }),
  build({
    id: 's02',
    scenario: 'S02',
    number: 'APX-7781',
    supplier: supplier('V002'),
    date: '2026-09-16',
    poNumber: 'PO-2026-0103',
    source: 'PDF',
    receivedLabel: 'Today, 07:48',
    lines: [{ ...BEARING, qtyMilli: kg(100), unitPricePaise: 14500 }],
    initialStatus: 'handled',
    handledNote: 'Matched to PO-2026-0103',
  }),
  build({
    id: 's01',
    scenario: 'S01',
    number: 'SSS/26-27/0451',
    supplier: supplier('V001'),
    date: '2026-09-15',
    poNumber: 'PO-2026-0101',
    source: 'PDF',
    receivedLabel: '15 Sep, 09:10',
    lines: [
      { ...ROD, qtyMilli: kg(1000), unitPricePaise: 6250 },
      { ...PLATE, qtyMilli: kg(500), unitPricePaise: 6800 },
    ],
    initialStatus: 'handled',
    handledNote: 'Matched to PO-2026-0101',
  }),
];

export const INVOICES: readonly DemoInvoice[] = [...ATTENTION, ...HANDLED];

/** The week the demo depicts. Only the invoices above exist as records; the rest are counts. */
export const WEEK = { received: 142, handled: 131, needsAttention: ATTENTION.length } as const;

export const invoiceById = (id: string): DemoInvoice | undefined =>
  INVOICES.find((i) => i.id === id);

export const BUYER = COMPANY;

export const qtyLabel = (l: DemoLine): string => `${formatQty(milliQty(l.qtyMilli))} ${l.uom}`;

/** Where on the document each question is visible, and what a photo leaves unreadable. */
export type DocField = 'supplier' | 'gstin' | 'number' | 'po' | 'qty' | 'rate' | 'tax' | 'total';

export const DOCUMENT_MARKS: Readonly<
  Record<string, { marked: readonly DocField[]; unreadable?: readonly DocField[] }>
> = {
  s10: { marked: ['qty'] },
  s14: { marked: ['total'], unreadable: ['total'] },
  s17: { marked: ['supplier', 'gstin'], unreadable: ['gstin'] },
  s09: { marked: ['rate'] },
  s08: { marked: ['qty', 'po'] },
  s07: { marked: ['po'] },
  s16: { marked: ['supplier'] },
  s04: { marked: ['po', 'total'] },
  s12: { marked: ['tax'] },
  s15: { marked: ['gstin'] },
  s11b: { marked: ['number'] },
};
