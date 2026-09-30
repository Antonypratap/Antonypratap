import {
  formatInr,
  formatQty,
  formatRate,
  milliQty,
  paise,
  questionKindOf,
  rateBp,
  type FieldPath,
  type QuestionCode,
  type RuleCode,
} from '@veyra/shared';
import { kindOfPath, parseStored, type FieldKind, type JsonValue } from './fields';
import type { Fact, InputSpec, OptionDraft, QuestionDraft } from './types';

/**
 * Question builders (RULES §5). Every option carries one typed effect; there is no override,
 * "ignore" or "continue anyway" option anywhere. Wording is business language only.
 */

export const rupees = (p: number): string => formatInr(paise(p));
export const qtyText = (m: number, uom: string): string => `${formatQty(milliQty(m))} ${uom}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dateText = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
};

export function displayValue(kind: FieldKind, value: JsonValue): string {
  const parsed = parseStored(kind, value);
  if (parsed === null) return String(value);
  switch (kind) {
    case 'money':
    case 'signedMoney':
      return rupees(parsed as number);
    case 'qty':
      return formatQty(milliQty(parsed as number));
    case 'rate':
      return formatRate(rateBp(parsed as number));
    case 'date':
      return dateText(parsed as string);
    default:
      return String(parsed);
  }
}

const HEADER_LABEL: Record<string, string> = {
  vendorName: 'supplier name',
  vendorGstin: 'supplier GSTIN',
  vendorAddress: 'supplier address',
  vendorPan: 'supplier PAN',
  buyerGstin: 'your GSTIN on the invoice',
  billingAddress: 'billing address',
  placeOfSupply: 'place of supply',
  shipToState: 'ship-to state',
  shipToGstin: 'ship-to GSTIN',
  shipToAddress: 'ship-to address',
  invoiceNumber: 'invoice number',
  invoiceDate: 'invoice date',
  poNumber: 'order number',
  taxablePaise: 'taxable value',
  cgstPaise: 'CGST',
  sgstPaise: 'SGST',
  igstPaise: 'IGST',
  cessPaise: 'cess',
  roundOffPaise: 'round-off',
  totalPaise: 'total',
};
const LINE_LABEL: Record<string, string> = {
  description: 'item description',
  vendorItemCode: 'item code',
  hsnSac: 'HSN code',
  qtyMilli: 'quantity',
  uom: 'unit',
  unitPricePaise: 'price',
  discountPaise: 'discount',
  taxablePaise: 'line amount',
  gstRateBp: 'GST rate',
  cgstPaise: 'line CGST',
  sgstPaise: 'line SGST',
  igstPaise: 'line IGST',
  lineTotalPaise: 'line total',
};

/** "the total", but "your GSTIN on the invoice" (never "the your …"). */
const theLabel = (label: string): string => (/^your\b/.test(label) ? label : `the ${label}`);

export function fieldLabel(path: string): string {
  const header = /^header\.(\w+)$/.exec(path);
  if (header) return HEADER_LABEL[header[1] ?? ''] ?? path;
  const line = /^lines\[(\d+)\]\.(\w+)$/.exec(path);
  return `${LINE_LABEL[line?.[2] ?? ''] ?? path} on line ${line?.[1]}`;
}

const cap = (s: string): string => (/^[a-z]/.test(s) ? s[0]?.toUpperCase() + s.slice(1) : s);

// ── Standard options ───────────────────────────────────────────────────────

export const rejectOption = (label = 'Reject this invoice'): OptionDraft => ({
  id: 'reject',
  label,
  effect: { type: 'REJECT_INVOICE' },
  emphasis: 'quiet',
  result: 'Invoice rejected.',
  input: null,
});

export const recheckOption = (label: string): OptionDraft => ({
  id: 'recheck',
  label,
  effect: { type: 'RECHECK' },
  emphasis: 'secondary',
  result: 'Veyrafy checked the invoice again.',
  input: null,
});

export function setFieldOption(
  path: FieldPath,
  label: string,
  emphasis: OptionDraft['emphasis'] = 'secondary',
  initial = '',
): OptionDraft {
  return {
    id: `set:${path}`,
    label,
    effect: { type: 'SET_FIELD', path },
    emphasis,
    result: `The ${fieldLabel(path)} was updated.`,
    input: {
      kind: 'value',
      field: kindOfPath(path) as Extract<InputSpec, { kind: 'value' }>['field'],
      label: cap(fieldLabel(path)),
      initial,
    },
  };
}

function draft(
  code: QuestionCode,
  subjectKey: string,
  body: Omit<QuestionDraft, 'code' | 'kind' | 'subjectKey'>,
): QuestionDraft {
  return { code, kind: questionKindOf(code), subjectKey, ...body };
}

// ── MISSING_DATA ───────────────────────────────────────────────────────────

export function mdField(
  path: FieldPath,
  read: { state: 'absent' | 'low_confidence' | 'unparseable'; shown: JsonValue | null },
  extra: { facts?: Fact[]; why?: string[] } = {},
): QuestionDraft {
  const label = fieldLabel(path);
  const kind = kindOfPath(path);
  const shown = read.shown !== null ? displayValue(kind, read.shown) : null;
  const confirmable =
    read.state === 'low_confidence' &&
    read.shown !== null &&
    parseStored(kind, read.shown) !== null;
  const summary =
    read.state === 'absent'
      ? `${cap(label)} missing`
      : read.state === 'unparseable'
        ? `${cap(label)} not readable`
        : `${cap(label)} unclear`;
  const options: OptionDraft[] = [];
  if (confirmable && shown) {
    options.push({
      id: 'confirm',
      label: `Yes, it's ${shown}`,
      effect: { type: 'CONFIRM_FIELD', path },
      emphasis: 'secondary',
      result: `Confirmed ${shown}.`,
      input: null,
    });
  }
  options.push(setFieldOption(path, `Enter ${theLabel(label)}`, 'primary'), rejectOption());
  return draft('MD_FIELD', path, {
    summary,
    evidence: !shown
      ? 'Not found on the invoice'
      : read.state === 'unparseable'
        ? `Veyrafy read ${shown}, but that is not a valid ${label.replace(/^your /, '')}`
        : confirmable
          ? `Veyrafy read ${shown}, but not clearly enough to use it`
          : `Veyrafy read ${shown}, but not clearly, and that is not a valid ${label.replace(/^your /, '')}`,
    headline: `What is ${theLabel(label)}?`,
    facts: [
      ...(shown ? [{ label: 'Veyrafy read', value: shown, tone: 'attention' as const }] : []),
      ...(extra.facts ?? []),
    ],
    why: [
      ...(extra.why ?? []),
      read.state === 'absent'
        ? 'Veyrafy could not find this on the invoice.'
        : read.state === 'unparseable'
          ? 'What Veyrafy read does not have the right format, so it cannot be used.'
          : confirmable
            ? 'The document is not clear enough here for Veyrafy to be certain.'
            : 'The document is not clear here, and what Veyrafy read is not in a valid format.',
      'Veyrafy uses a value only when it has been read with certainty.',
      'It never fills in a value from anywhere else.',
    ],
    paths: [path],
    options,
  });
}

// ── AMBIGUOUS_MATCH ────────────────────────────────────────────────────────

export interface VendorCandidate {
  id: string;
  code: string;
  name: string;
  gstin: string;
}

export function amVendor(
  code: 'AM_VENDOR' | 'AM_VENDOR_PAN',
  printedName: string,
  candidates: readonly VendorCandidate[],
  gstinUnreadable: boolean,
): QuestionDraft {
  const n = candidates.length;
  return draft(code, 'vendor', {
    summary: 'Which supplier?',
    evidence:
      code === 'AM_VENDOR_PAN'
        ? `Same business as ${n === 1 ? 'a supplier' : `${n} suppliers`} in your records`
        : n === 1
          ? `One supplier in your records is called ${candidates[0]?.name}`
          : `${n} suppliers are called ${printedName}`,
    headline: 'Which supplier sent this invoice?',
    facts: [
      { label: 'Name on the invoice', value: printedName },
      ...candidates.map((c) => ({
        label: `${c.code} in your records`,
        value: `${c.name} · ${c.gstin}`,
      })),
    ],
    why: [
      gstinUnreadable
        ? 'The GSTIN on the invoice could not be read, so the supplier cannot be identified from it.'
        : code === 'AM_VENDOR_PAN'
          ? 'The GSTIN is new, but its PAN belongs to a supplier you already have: this may be another GST registration of the same business.'
          : 'No supplier in your records has this GSTIN, but some have the same name.',
      'Veyrafy never links a supplier by name alone.',
    ],
    paths: ['header.vendorName', 'header.vendorGstin'],
    options: [
      ...candidates.map((c, i): OptionDraft => ({
        id: `vendor:${c.id}`,
        label: `${c.name} (${c.gstin})`,
        effect: { type: 'LINK_ERP_RECORD', entity: 'vendor', erpId: c.id as never, lineNo: null },
        emphasis: i === 0 ? 'primary' : 'secondary',
        result: `Supplier set to ${c.name}.`,
        input: null,
      })),
      {
        id: 'new',
        label:
          code === 'AM_VENDOR_PAN'
            ? 'It is a new registration'
            : "None of these, it's a new supplier",
        effect: { type: 'REQUEST_CREATION', entity: 'vendor', lineNo: null },
        emphasis: 'quiet',
        result: 'Veyrafy will prepare a new supplier for your approval.',
        input: null,
      },
      rejectOption(),
    ],
  });
}

export interface PoCandidate {
  id: string;
  poNumber: string;
  summary: string;
}

export function amOpenPo(candidates: readonly PoCandidate[], vendorName: string): QuestionDraft {
  return draft('AM_OPEN_PO', 'po', {
    summary: 'Which order?',
    evidence:
      candidates.length === 1
        ? `${candidates[0]?.poNumber} is open for ${vendorName}`
        : `${candidates.length} open orders could match`,
    headline: 'Which purchase order is this invoice for?',
    facts: candidates.map((c) => ({ label: c.poNumber, value: c.summary })),
    why: [
      'The invoice does not print an order number.',
      `${vendorName} has open orders, so Veyrafy will not create a new one or pick one for you.`,
    ],
    paths: ['header.poNumber'],
    options: [
      ...candidates.map((c, i): OptionDraft => ({
        id: `po:${c.id}`,
        label: c.poNumber,
        effect: { type: 'LINK_ERP_RECORD', entity: 'po', erpId: c.id as never, lineNo: null },
        emphasis: i === 0 ? 'primary' : 'secondary',
        result: `Matched to ${c.poNumber}.`,
        input: null,
      })),
      {
        id: 'non-po',
        label: 'It is not against any of these orders',
        effect: { type: 'DECLARE_NON_PO' },
        emphasis: 'quiet',
        result: 'Veyrafy will follow your purchase order policy.',
        input: null,
      },
      rejectOption(),
    ],
  });
}

export function amPoLine(
  lineNo: number,
  description: string,
  candidates: readonly { id: string; label: string }[],
): QuestionDraft {
  return draft('AM_PO_LINE', `line:${lineNo}`, {
    summary: 'Which order line?',
    evidence: `${candidates.length} order lines could match line ${lineNo}`,
    headline: `Which order line is "${description}" for?`,
    facts: candidates.map((c) => ({ label: 'Order line', value: c.label })),
    why: [
      'More than one line on the order has the same item type.',
      'Veyrafy never matches a line by its price.',
    ],
    paths: [`lines[${lineNo}].description`],
    options: [
      ...candidates.map((c, i): OptionDraft => ({
        id: `po_line:${c.id}`,
        label: c.label,
        effect: { type: 'LINK_ERP_RECORD', entity: 'po_line', erpId: c.id as never, lineNo },
        emphasis: i === 0 ? 'primary' : 'secondary',
        result: 'Order line chosen.',
        input: null,
      })),
      rejectOption(),
    ],
  });
}

export function amItem(
  lineNo: number,
  description: string,
  hsnSac: string,
  candidates: readonly { id: string; code: string; name: string }[],
): QuestionDraft {
  return draft('AM_ITEM', `line:${lineNo}`, {
    summary: 'Which item?',
    evidence: `${candidates.length} items share HSN ${hsnSac}`,
    headline: `Which item is "${description}"?`,
    facts: candidates.map((c) => ({ label: c.code, value: c.name })),
    why: [
      'No item in your records has exactly this name and HSN code.',
      'Veyrafy never picks an item for you.',
    ],
    paths: [`lines[${lineNo}].description`, `lines[${lineNo}].hsnSac`],
    options: [
      ...candidates.map((c, i): OptionDraft => ({
        id: `item:${c.id}`,
        label: `${c.name} (${c.code})`,
        effect: { type: 'LINK_ERP_RECORD', entity: 'item', erpId: c.id as never, lineNo },
        emphasis: i === 0 ? 'primary' : 'secondary',
        result: `Item set to ${c.name}.`,
        input: null,
      })),
      {
        id: 'new',
        label: "None of these, it's a new item",
        effect: { type: 'REQUEST_CREATION', entity: 'item', lineNo },
        emphasis: 'quiet',
        result: 'Veyrafy will prepare a new item for your approval.',
        input: null,
      },
      rejectOption(),
    ],
  });
}

// ── BUSINESS_DECISION ──────────────────────────────────────────────────────

export function bdVendorInactive(vendorName: string, vendorCode: string): QuestionDraft {
  return draft('BD_VENDOR_INACTIVE', 'vendor', {
    summary: 'Inactive supplier',
    evidence: `${vendorName} is marked inactive`,
    headline: `${vendorName} is inactive in your records. Reactivate them?`,
    facts: [
      { label: 'Supplier', value: `${vendorName} (${vendorCode})` },
      { label: 'Status in your records', value: 'Inactive', tone: 'attention' },
    ],
    why: ['Invoices from inactive suppliers are not recorded without a decision.'],
    paths: ['header.vendorName'],
    options: [
      {
        id: 'reactivate',
        label: 'Reactivate and continue',
        effect: { type: 'APPROVE_CREATION', entity: 'vendor_reactivation' },
        emphasis: 'primary',
        result: `${vendorName} will be reactivated when the invoice is recorded.`,
        input: null,
      },
      rejectOption(),
    ],
  });
}

export function bdPoClosed(poNumber: string): QuestionDraft {
  return draft('BD_PO_CLOSED', 'po', {
    summary: 'Order is closed',
    evidence: `${poNumber} is closed`,
    headline: `The invoice cites ${poNumber}, which is closed.`,
    facts: [
      { label: 'Order', value: poNumber },
      { label: 'Status in your records', value: 'Closed', tone: 'attention' },
    ],
    why: ['Veyrafy does not record invoices against a closed order, and never reopens one.'],
    paths: ['header.poNumber'],
    options: [recheckOption('It was reopened. Check again'), rejectOption()],
  });
}

// ── CREATION_APPROVAL ──────────────────────────────────────────────────────

export function caVendor(
  name: string,
  gstin: string,
  address: string,
  state: string,
): QuestionDraft {
  return draft('CA_VENDOR', 'vendor', {
    summary: 'New supplier',
    evidence: `${name} is not in your records`,
    headline: `Add ${name} as a new supplier?`,
    facts: [
      { label: 'Name', value: name },
      { label: 'GSTIN', value: gstin },
      { label: 'PAN', value: gstin.slice(2, 12) },
      { label: 'State', value: state },
      { label: 'Address', value: address },
    ],
    why: [
      'You said this is a new supplier.',
      'Bank details on an invoice are never used: they stay unverified and Veyrafy makes no payment.',
    ],
    paths: ['header.vendorName', 'header.vendorGstin', 'header.vendorAddress'],
    options: [
      {
        id: 'approve',
        label: 'Add supplier and continue',
        effect: { type: 'APPROVE_CREATION', entity: 'vendor' },
        emphasis: 'primary',
        result: `${name} will be added when the invoice is recorded.`,
        input: null,
      },
      rejectOption('Decline and reject the invoice'),
    ],
  });
}

export function caItem(
  lineNo: number,
  line: { description: string; hsnSac: string; uom: string; gstRateBp: number },
): QuestionDraft {
  return draft('CA_ITEM', `line:${lineNo}`, {
    summary: 'New item',
    evidence: `"${line.description}" is not in your item list`,
    headline: `Add "${line.description}" to your items?`,
    facts: [
      { label: 'HSN code', value: line.hsnSac },
      { label: 'Unit', value: line.uom },
      { label: 'GST rate', value: formatRate(rateBp(line.gstRateBp)) },
    ],
    why: [
      'New items are never created without your approval.',
      'The item will be used for this invoice and saved to your item list when the invoice is recorded.',
    ],
    paths: [`lines[${lineNo}].description`, `lines[${lineNo}].hsnSac`],
    options: [
      {
        id: 'approve',
        label: 'Add item and continue',
        effect: { type: 'APPROVE_CREATION', entity: 'item' },
        emphasis: 'primary',
        result: 'The item will be added when the invoice is recorded.',
        input: {
          kind: 'item',
          initial: {
            name: line.description,
            hsnSac: line.hsnSac,
            uom: line.uom,
            gstRate: formatRate(rateBp(line.gstRateBp)),
          },
        },
      },
      rejectOption('Decline and reject the invoice'),
    ],
  });
}

export function caPo(
  reason: 'disabled' | 'at_or_above',
  totalPaise: number,
  limitPaise: number,
): QuestionDraft {
  return draft('CA_PO', 'po', {
    summary: 'No purchase order',
    evidence:
      reason === 'disabled'
        ? 'Creating orders automatically is turned off'
        : `Above your ${rupees(limitPaise)} limit for creating one`,
    headline: 'Create a purchase order from this invoice?',
    facts: [
      { label: 'Invoice total', value: rupees(totalPaise) },
      ...(reason === 'at_or_above'
        ? [{ label: 'Automatic limit', value: `Below ${rupees(limitPaise)}` }]
        : []),
    ],
    why: [
      'The invoice has no order number and the supplier has no open order.',
      'A new order would copy the invoice lines. Its number is assigned by your ERP; Veyrafy never invents one.',
    ],
    paths: ['header.poNumber', 'header.totalPaise'],
    options: [
      {
        id: 'approve',
        label: 'Create a purchase order',
        effect: { type: 'APPROVE_CREATION', entity: 'po' },
        emphasis: 'primary',
        result: 'A purchase order will be created when the invoice is recorded.',
        input: null,
      },
      setFieldOption('header.poNumber', 'Enter the existing order number'),
      rejectOption(),
    ],
  });
}

export function caGrn(
  subjectKey: string,
  po: { label: string; date: string },
  today: string,
  lines: { poLineNo: number; label: string; uom: string; suggestedQtyMilli: number }[],
  additional: boolean,
): QuestionDraft {
  return draft('CA_GRN', subjectKey, {
    summary: additional ? 'Additional receipt' : 'Receipt not recorded',
    evidence: additional
      ? `Record more goods received for ${po.label}`
      : `Found the supplier and ${po.label}, but no goods receipt yet`,
    headline: 'Did the goods arrive?',
    facts: lines.map((l) => ({
      label: l.label,
      value: `Invoiced ${qtyText(l.suggestedQtyMilli, l.uom)}`,
    })),
    why: [
      'An invoice is recorded only against goods you confirm were received.',
      'Veyrafy never assumes goods arrived because an invoice came in.',
    ],
    paths: lines.map((_, i) => `lines[${i + 1}].qtyMilli`),
    options: [
      {
        id: 'confirm',
        label: 'Yes, record the receipt',
        effect: { type: 'APPROVE_CREATION', entity: 'grn' },
        emphasis: 'primary',
        result: 'Receipt recorded. It is written to your ERP with the invoice.',
        input: {
          kind: 'grn',
          poLabel: po.label,
          minDate: po.date,
          maxDate: today,
          lines: lines.map((l) => ({
            poLineNo: l.poLineNo,
            label: l.label,
            uom: l.uom,
            suggestedQty: formatQty(milliQty(l.suggestedQtyMilli)),
          })),
        },
      },
      rejectOption('No, reject this invoice'),
    ],
  });
}

// ── VALIDATION_FAILURE ─────────────────────────────────────────────────────

export interface VfSpec {
  rule: RuleCode;
  lineNo: number | null;
  summary: string;
  evidence: string;
  headline: string;
  facts: Fact[];
  why: string[];
  /** Fields the rule depends on that the user may say were misread. */
  corrections: { path: FieldPath; label: string }[];
  recheckLabel: string;
  /** VF_R26 only: offer to record an additional receipt. */
  offerReceipt?: boolean;
}

export function vf(spec: VfSpec): QuestionDraft {
  const subject = spec.lineNo === null ? spec.rule : `${spec.rule}:line:${spec.lineNo}`;
  const options: OptionDraft[] = [];
  if (spec.offerReceipt) {
    options.push({
      id: 'receipt',
      label: 'Record the additional receipt',
      effect: { type: 'REQUEST_CREATION', entity: 'grn', lineNo: null },
      emphasis: 'primary',
      result: 'Veyrafy will ask you for the receipt details.',
      input: null,
    });
  }
  spec.corrections.forEach((c, i) =>
    options.push(
      setFieldOption(c.path, c.label, !spec.offerReceipt && i === 0 ? 'primary' : 'secondary'),
    ),
  );
  options.push(recheckOption(spec.recheckLabel), rejectOption());
  return draft(`VF_${spec.rule}`, subject, {
    summary: spec.summary,
    evidence: spec.evidence,
    headline: spec.headline,
    facts: spec.facts,
    why: [...spec.why, 'There is no tolerance and no override: the numbers must agree exactly.'],
    paths: spec.corrections.map((c) => c.path),
    options,
  });
}
