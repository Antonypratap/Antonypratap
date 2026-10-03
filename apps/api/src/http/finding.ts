import type { ApiEvidence, ApiFinding } from '@veyra/shared';
import type { StoredField } from '../engine/fields';
import { displayValue, fieldLabel, qtyText, rupees } from '../engine/questions';
import { HEADER_KINDS, LINE_KINDS } from '../engine/fields';

/**
 * The invoice's exception as a conclusion (DECISION → EXPLANATION → EVIDENCE), built only from
 * what Veyrafy already recorded: the open question (code, subject, facts, fields it names), the
 * failed check behind it (its expected and actual values) and the fields as read, with their place
 * on the page. Nothing is estimated: an amount is shown only when the check's own numbers give it.
 */

type Fact = { label: string; value: string; tone?: 'attention' };

export interface FindingQuestion {
  code: string;
  kind: string;
  subjectKey: string;
  summary: string;
  headline: string;
  facts: Fact[];
  paths: string[];
}

export interface FindingCheck {
  rule: string;
  lineNo: number | null;
  expected: unknown;
  actual: unknown;
}

export interface ReceiptDifferences {
  grnNo: string;
  differences: {
    section: string;
    label: string;
    invoice: string | null;
    erp: string | null;
    path: string | null;
  }[];
  totalDeltaPaise: number | null;
}

export interface FindingInput {
  /** The open questions, in the order they were raised; the first is the one shown. */
  questions: FindingQuestion[];
  /** Failed checks of the latest run. */
  failed: FindingCheck[];
  fields: Map<string, StoredField>;
  /** The invoice total as read (for a duplicate: the amount that would be paid twice). */
  totalPaise: number | null;
  /** The differences from the ERP receipt record, for an invoice checked against one. */
  receipt: ReceiptDifferences | null;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const sum = (x: unknown): number | null =>
  Array.isArray(x) && x.every((v) => typeof v === 'number')
    ? (x as number[]).reduce((a, b) => a + b, 0)
    : num(x);

/** "₹1,250.00 more than agreed" / "₹300.00 less than agreed" / "No amount difference". */
function impactText(paise: number | null, versus: string): string {
  if (paise === null) return 'Amount to confirm';
  if (paise === 0) return 'No amount difference';
  return `${rupees(Math.abs(paise))} ${paise > 0 ? 'more' : 'less'} than ${versus}`;
}

const lineOf = (subjectKey: string): number | null => {
  const m = /:line:(\d+)$/.exec(subjectKey);
  return m ? Number(m[1]) : null;
};

/** A fact about the invoice itself (the rest are what the ERP or the calculation says). */
const onInvoice = (f: Fact): boolean =>
  f.tone === 'attention' ||
  /^(invoice\b|invoiced\b|veyrafy read\b)|\bon the invoice\b/i.test(f.label) ||
  /^invoiced\b/i.test(f.value);

/** The agreed or recorded value first, the invoice's second (facts are written invoice-first). */
function agreedFirst(facts: Fact[]): Fact[] {
  const invoice = facts
    .filter(onInvoice)
    .map((f) => ({ label: f.label, value: f.value, tone: 'attention' as const }));
  const other = facts.filter((f) => !onInvoice(f) && f.label !== 'Difference');
  return [...other, ...invoice];
}

/** A field's value and place on the page, as evidence. */
function fieldEvidence(fields: Map<string, StoredField>, path: string): ApiEvidence | null {
  const f = fields.get(path);
  if (!f || f.value === null) return null;
  const header = /^header\.(\w+)$/.exec(path);
  const line = /^lines\[\d+\]\.(\w+)$/.exec(path);
  const kind = header
    ? HEADER_KINDS[header[1] as keyof typeof HEADER_KINDS]
    : line
      ? LINE_KINDS[line[1] as keyof typeof LINE_KINDS]
      : undefined;
  const label = fieldLabel(path);
  return {
    label: `Invoice · ${label[0]?.toLowerCase() + label.slice(1)}`,
    value: kind ? displayValue(kind, f.value) : String(f.value),
    source: 'invoice',
    page: f.evidence?.page ?? null,
    bbox: f.evidence?.bbox ?? null,
  };
}

/** The ERP's side of the comparison, as evidence. */
function erpEvidence(facts: Fact[]): ApiEvidence[] {
  return facts
    .filter((f) => !onInvoice(f) && f.label !== 'Difference')
    .map((f) => ({ label: f.label, value: f.value, source: 'erp', page: null, bbox: null }));
}

interface Shape {
  type: ApiFinding['type'];
  state: ApiFinding['state'];
  label: string;
  action: string;
}

/** What kind of exception a question is, in the words the screen uses. */
function shapeOf(q: FindingQuestion): Shape {
  const review = (type: Shape['type'], label: string, action: string): Shape => ({
    type,
    state: 'review',
    label,
    action,
  });
  const confirm = (type: Shape['type'], label: string, action: string): Shape => ({
    type,
    state: 'confirm',
    label,
    action,
  });
  switch (q.code) {
    case 'VF_R21':
      return review('rate', 'Rate difference', 'Check rate');
    case 'VF_R23':
    case 'VF_R26':
      return review('quantity', 'Quantity difference', 'Check quantity');
    case 'VF_R07':
      return review('tax', 'Tax difference', 'Check tax');
    case 'VF_R08':
      return review('tax', 'Wrong tax type', 'Check tax');
    case 'VF_R16':
    case 'VF_R22':
      return review('tax', 'GST rate difference', 'Check tax');
    case 'VF_R06':
      return review('totals', 'Line amount difference', 'Check line');
    case 'VF_R09':
      return review('totals', 'Totals difference', 'Check totals');
    case 'VF_R10':
      return review('totals', 'Round-off difference', 'Check totals');
    case 'VF_R11':
      return review('duplicate', 'Possible duplicate', 'Resolve duplicate');
    case 'VF_R03':
    case 'VF_R04':
      return review('supplier', q.summary, 'Confirm supplier');
    case 'AM_VENDOR':
    case 'AM_VENDOR_PAN':
    case 'CA_VENDOR':
    case 'BD_VENDOR_INACTIVE':
      return confirm('supplier', q.summary, 'Confirm supplier');
    case 'VF_R15':
    case 'VF_R27':
    case 'VF_R20':
    case 'AM_ITEM':
    case 'CA_ITEM':
    case 'AM_PO_LINE':
      return (q.kind === 'VALIDATION_FAILURE' ? review : confirm)('item', q.summary, 'Check item');
    case 'VF_R17':
    case 'VF_R18':
    case 'VF_R19':
    case 'VF_R24':
    case 'AM_OPEN_PO':
    case 'CA_PO':
    case 'BD_PO_CLOSED':
      return (q.kind === 'VALIDATION_FAILURE' || q.kind === 'BUSINESS_DECISION' ? review : confirm)(
        'order',
        q.summary,
        'Check order',
      );
    case 'CA_GRN':
      return confirm('receipt', q.summary, 'Confirm receipt');
    case 'MD_FIELD':
      return confirm('value', q.summary, 'Confirm value');
    default:
      return (q.kind === 'VALIDATION_FAILURE' || q.kind === 'BUSINESS_DECISION' ? review : confirm)(
        'other',
        q.summary,
        q.kind === 'VALIDATION_FAILURE' ? 'Check value' : 'Confirm',
      );
  }
}

/** Amount, explanation and calculation for the exceptions whose checks carry numbers. */
function numbers(
  q: FindingQuestion,
  check: FindingCheck | undefined,
  fields: Map<string, StoredField>,
  totalPaise: number | null,
): Pick<ApiFinding, 'impactPaise' | 'explanation' | 'difference' | 'calculation'> | null {
  const line = lineOf(q.subjectKey);
  const read = (k: string) =>
    line === null ? null : num(fields.get(`lines[${line}].${k}`)?.value);
  const uom = line === null ? null : (fields.get(`lines[${line}].uom`)?.value as string | null);
  const expected = num(check?.expected);
  const actual = num(check?.actual);
  switch (q.code) {
    case 'VF_R21': {
      const qty = read('qtyMilli');
      if (expected === null || actual === null) return null;
      const per = actual - expected;
      const each = `${rupees(Math.abs(per))} per ${uom ?? 'unit'}`;
      const impact = qty === null ? null : Math.round((per * qty) / 1000);
      return {
        impactPaise: impact,
        explanation: `The supplier billed ${each} ${per > 0 ? 'above' : 'below'} the rate agreed on the order.`,
        difference: `${per > 0 ? '+' : '−'}${each}`,
        calculation:
          qty === null || impact === null
            ? null
            : `${each} × ${qtyText(qty, uom ?? 'units')} = ${rupees(Math.abs(impact))} ${impact > 0 ? 'overbilled' : 'underbilled'}`,
      };
    }
    case 'VF_R23':
    case 'VF_R26': {
      const price = read('unitPricePaise');
      if (expected === null || actual === null) return null;
      const extra = actual - Math.max(0, expected);
      const impact = price === null ? null : Math.round((extra * price) / 1000);
      const what = q.code === 'VF_R26' ? 'was received' : 'is left on the order';
      return {
        impactPaise: impact,
        explanation: `The invoice bills ${qtyText(extra, uom ?? 'units')} more than ${what}.`,
        difference: `+${qtyText(extra, uom ?? 'units')}`,
        calculation:
          price === null || impact === null
            ? null
            : `${qtyText(extra, uom ?? 'units')} × ${rupees(price)} = ${rupees(impact)} for goods ${q.code === 'VF_R26' ? 'not received' : 'not ordered'}`,
      };
    }
    case 'VF_R07':
    case 'VF_R06':
    case 'VF_R09':
    case 'VF_R10': {
      const e = sum(check?.expected);
      const a = sum(check?.actual);
      if (e === null || a === null) return null;
      const impact = a - e;
      const what =
        q.code === 'VF_R07'
          ? 'tax'
          : q.code === 'VF_R06'
            ? `amount on line ${line ?? ''}`.trim()
            : q.code === 'VF_R10'
              ? 'round-off'
              : 'total';
      return {
        impactPaise: impact,
        explanation: `The ${what} printed on the invoice is ${rupees(Math.abs(impact))} ${impact > 0 ? 'more' : 'less'} than the calculation.`,
        difference: `${impact > 0 ? '+' : '−'}${rupees(Math.abs(impact))}`,
        calculation: `${rupees(a)} printed − ${rupees(e)} calculated = ${impact < 0 ? '−' : ''}${rupees(Math.abs(impact))}`,
      };
    }
    case 'VF_R11':
      return {
        impactPaise: totalPaise,
        explanation:
          'This supplier’s invoice number is already recorded for the financial year; paying it again would pay twice.',
        difference: null,
        calculation: null,
      };
    default:
      return null;
  }
}

/** Short versus-word for the impact line. */
function versusOf(type: ApiFinding['type']): string {
  if (type === 'tax' || type === 'totals') return 'calculated';
  if (type === 'quantity') return 'received';
  return 'agreed';
}

function fromQuestion(input: FindingInput, q: FindingQuestion): ApiFinding {
  const shape = shapeOf(q);
  const line = lineOf(q.subjectKey);
  const check = input.failed.find(
    (c) => `VF_${c.rule}` === q.code && (line === null || c.lineNo === line),
  );
  const n = numbers(q, check, input.fields, input.totalPaise);
  const differenceFact = q.facts.find((f) => f.label === 'Difference');
  const paths = q.paths.length ? q.paths : [];
  const evidence = [
    ...paths.flatMap((p) => fieldEvidence(input.fields, p) ?? []),
    // Tax and totals are compared with Veyrafy's own calculation, not with an ERP record.
    ...(['VF_R06', 'VF_R07', 'VF_R09', 'VF_R10'].includes(q.code) ? [] : erpEvidence(q.facts)),
  ];
  const impactPaise = n?.impactPaise ?? null;
  return {
    ...shape,
    impactPaise,
    impact:
      shape.type === 'duplicate'
        ? impactPaise === null
          ? 'May be paid twice'
          : `${rupees(impactPaise)} could be paid twice`
        : n
          ? impactText(impactPaise, q.code === 'VF_R23' ? 'ordered' : versusOf(shape.type))
          : shape.state === 'confirm'
            ? 'Needs confirmation'
            : 'Needs review',
    explanation: n?.explanation ?? q.headline,
    compare: agreedFirst(q.facts),
    difference: n?.difference ?? differenceFact?.value ?? null,
    calculation: n?.calculation ?? null,
    evidence,
    more: input.questions.length - 1,
  };
}

const RECEIPT_TYPE: Record<string, ApiFinding['type']> = {
  Rate: 'rate',
  Quantity: 'quantity',
  CGST: 'tax',
  SGST: 'tax',
  IGST: 'tax',
  Name: 'supplier',
  Item: 'item',
  'HSN/SAC': 'item',
};
const RECEIPT_ACTION: Partial<Record<ApiFinding['type'], string>> = {
  rate: 'Check rate',
  quantity: 'Check quantity',
  tax: 'Check tax',
  supplier: 'Confirm supplier',
  item: 'Check item',
};

/** The invoice's own checks on the receipt path, named as the screen names them. */
const RECEIPT_OWN: Record<string, { type: ApiFinding['type']; label: string; action: string }> = {
  'Not already in Veyrafy': {
    type: 'duplicate',
    label: 'Possible duplicate',
    action: 'Resolve duplicate',
  },
  'GSTIN valid': { type: 'supplier', label: 'Invalid supplier GSTIN', action: 'Check supplier' },
  'GST calculated from the rates': {
    type: 'tax',
    label: "Tax doesn't add up",
    action: 'Check tax',
  },
  'Lines + tax + round-off = total': {
    type: 'totals',
    label: "Totals don't add up",
    action: 'Check totals',
  },
};

function fromReceipt(input: FindingInput, r: ReceiptDifferences): ApiFinding | null {
  // Most serious first: a duplicate, an invalid GSTIN, then the value behind a difference (a
  // line or supplier value) before the totals it moves, then the invoice's own arithmetic.
  const first =
    r.differences.find((d) => d.label === 'Not already in Veyrafy') ??
    r.differences.find((d) => d.label === 'GSTIN valid') ??
    r.differences.find(
      (d) => d.section !== 'Totals' && d.section !== 'Invoice arithmetic' && d.label !== 'Amount',
    ) ??
    r.differences[0];
  if (!first) return null;
  const own =
    RECEIPT_OWN[first.label] ??
    (first.section === 'Invoice arithmetic'
      ? { type: 'totals' as const, label: "Line amount doesn't add up", action: 'Check line' }
      : null);
  const type = own?.type ?? RECEIPT_TYPE[first.label] ?? 'totals';
  const delta = r.totalDeltaPaise;
  const others = r.differences.length - 1;
  return {
    type,
    state: 'review',
    label:
      own?.label ??
      (type === 'totals'
        ? `${first.label} difference`
        : `${type[0]?.toUpperCase()}${type.slice(1)} difference`),
    action: own?.action ?? RECEIPT_ACTION[type] ?? 'Check totals',
    impactPaise: type === 'duplicate' ? input.totalPaise : delta,
    impact:
      type === 'duplicate'
        ? input.totalPaise === null
          ? 'May be paid twice'
          : `${rupees(input.totalPaise)} could be paid twice`
        : impactText(delta, `ERP receipt GRN ${r.grnNo}`),
    explanation: own
      ? `${first.label === 'Not already in Veyrafy' ? `${first.erp ?? 'Another copy is in Veyrafy'}.` : `The invoice says ${first.invoice ?? 'nothing'}; ${first.erp ?? ''}.`}`
      : `${first.section}: the invoice says ${first.invoice ?? 'nothing'}, your ERP receipt GRN ${r.grnNo} says ${first.erp ?? 'nothing'}.`,
    compare: [
      {
        label: own
          ? first.section === 'Invoice arithmetic'
            ? 'Calculated'
            : 'Veyrafy found'
          : `ERP receipt GRN ${r.grnNo}`,
        value: first.erp ?? 'Not in the receipt',
      },
      { label: 'Invoice', value: first.invoice ?? 'Not on the invoice', tone: 'attention' },
    ],
    difference: null,
    calculation:
      delta === null || delta === 0
        ? null
        : `Invoice total before round-off − ERP receipt total = ${delta < 0 ? '−' : ''}${rupees(Math.abs(delta))}`,
    evidence: [
      ...(first.path ? [fieldEvidence(input.fields, first.path)].flatMap((e) => e ?? []) : []),
      ...(first.erp
        ? [
            {
              label: `ERP receipt GRN ${r.grnNo} · ${first.label.toLowerCase()}`,
              value: first.erp,
              source: 'erp' as const,
              page: null,
              bbox: null,
            },
          ]
        : []),
    ],
    more: others + input.questions.length,
  };
}

export function buildFinding(input: FindingInput): ApiFinding | null {
  const q = input.questions[0];
  if (q) return fromQuestion(input, q);
  return input.receipt ? fromReceipt(input, input.receipt) : null;
}
