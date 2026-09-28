import type { FixedQuestionCode, QuestionCode } from './questions';

/**
 * Validation rule catalogue (RULES.md §4.2). This is data only: the rule functions themselves
 * belong to the validation engine (Phase 7).
 *
 * `stage` is the question-gating stage (RULES §4): 1 intrinsic, 2 vendor, 3 PO and items, 4 GRN.
 */
export const NA_REASONS = ['PO_DERIVED_FROM_INVOICE', 'NO_ROUND_OFF_LINE'] as const;
export type NaReason = (typeof NA_REASONS)[number];

export const GATING_STAGES = [1, 2, 3, 4] as const;
export type GatingStage = (typeof GATING_STAGES)[number];

interface RuleDefinition {
  readonly name: string;
  readonly stage: GatingStage;
  readonly allowedNaReasons: readonly NaReason[];
  /** Question raised when the rule fails, if it is not the default `VF_<code>`. */
  readonly failureQuestion?: FixedQuestionCode;
}

const PO_DERIVED = ['PO_DERIVED_FROM_INVOICE'] as const;

export const RULES = {
  R01: { name: 'REQUIRED_FIELDS', stage: 1, allowedNaReasons: [] },
  R02: { name: 'LINES_PRESENT', stage: 1, allowedNaReasons: [] },
  R03: { name: 'GSTIN_VALID', stage: 1, allowedNaReasons: [] },
  R04: { name: 'BUYER_IS_COMPANY', stage: 1, allowedNaReasons: [] },
  R05: { name: 'INVOICE_DATE_VALID', stage: 1, allowedNaReasons: [] },
  R06: { name: 'LINE_AMOUNT', stage: 1, allowedNaReasons: [] },
  R07: { name: 'TAX_AMOUNT', stage: 1, allowedNaReasons: [] },
  R08: { name: 'TAX_TYPE', stage: 1, allowedNaReasons: [] },
  R09: { name: 'HEADER_TOTALS', stage: 1, allowedNaReasons: [] },
  R10: { name: 'ROUND_OFF', stage: 1, allowedNaReasons: ['NO_ROUND_OFF_LINE'] },
  R11: { name: 'NOT_DUPLICATE', stage: 1, allowedNaReasons: [] },
  R12: { name: 'VENDOR_RESOLVED', stage: 2, allowedNaReasons: [] },
  R13: {
    name: 'VENDOR_ACTIVE',
    stage: 2,
    allowedNaReasons: [],
    failureQuestion: 'BD_VENDOR_INACTIVE',
  },
  R14: { name: 'ITEMS_RESOLVED', stage: 3, allowedNaReasons: [] },
  R15: { name: 'HSN_MATCH', stage: 3, allowedNaReasons: [] },
  R16: { name: 'ITEM_GST_RATE', stage: 3, allowedNaReasons: [] },
  R17: { name: 'PO_RESOLVED', stage: 3, allowedNaReasons: [] },
  R18: { name: 'PO_VENDOR', stage: 3, allowedNaReasons: [] },
  R19: { name: 'PO_OPEN', stage: 3, allowedNaReasons: [], failureQuestion: 'BD_PO_CLOSED' },
  R20: { name: 'LINE_ON_PO', stage: 3, allowedNaReasons: [] },
  R21: { name: 'PO_PRICE', stage: 3, allowedNaReasons: PO_DERIVED },
  R22: { name: 'PO_GST_RATE', stage: 3, allowedNaReasons: PO_DERIVED },
  R23: { name: 'PO_QTY_REMAINING', stage: 3, allowedNaReasons: PO_DERIVED },
  R24: { name: 'DATE_NOT_BEFORE_PO', stage: 3, allowedNaReasons: PO_DERIVED },
  R25: { name: 'GRN_EXISTS', stage: 4, allowedNaReasons: [], failureQuestion: 'CA_GRN' },
  R26: { name: 'GRN_QTY_COVERS', stage: 4, allowedNaReasons: [] },
  R27: { name: 'UOM_MATCH', stage: 3, allowedNaReasons: [] },
} as const satisfies Record<string, RuleDefinition>;

export type RuleCode = keyof typeof RULES;
export const RULE_CODES = Object.keys(RULES) as [RuleCode, ...RuleCode[]];

export function isNaReasonAllowed(rule: RuleCode, reason: NaReason): boolean {
  return (RULES[rule].allowedNaReasons as readonly NaReason[]).includes(reason);
}

/** The question raised when `rule` fails: its override, or `VF_<rule>`. */
export function failureQuestionFor(rule: RuleCode): QuestionCode {
  const def: RuleDefinition = RULES[rule];
  return def.failureQuestion ?? `VF_${rule}`;
}
