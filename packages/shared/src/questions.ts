import { z } from 'zod';
import { CREATION_ENTITIES, type QuestionKind } from './enums';
import { FieldPathSchema, isFieldPath } from './fields';
import { ErpIdSchema } from './ids';
import type { RuleCode } from './rules';

/**
 * Question catalogue (RULES.md §5). Data and contracts only: builders and answer application
 * belong to the questions module (Phase 8).
 */
export const FIXED_QUESTION_CODES = {
  MD_FIELD: 'MISSING_DATA',
  AM_VENDOR: 'AMBIGUOUS_MATCH',
  AM_VENDOR_PAN: 'AMBIGUOUS_MATCH',
  AM_OPEN_PO: 'AMBIGUOUS_MATCH',
  AM_PO_LINE: 'AMBIGUOUS_MATCH',
  AM_ITEM: 'AMBIGUOUS_MATCH',
  BD_VENDOR_INACTIVE: 'BUSINESS_DECISION',
  BD_PO_CLOSED: 'BUSINESS_DECISION',
  CA_VENDOR: 'CREATION_APPROVAL',
  CA_ITEM: 'CREATION_APPROVAL',
  CA_PO: 'CREATION_APPROVAL',
  CA_GRN: 'CREATION_APPROVAL',
} as const satisfies Record<string, QuestionKind>;
export type FixedQuestionCode = keyof typeof FIXED_QUESTION_CODES;

/** Every validation-failure question is `VF_<rule code>`. */
export type ValidationFailureQuestionCode = `VF_${RuleCode}`;
export type QuestionCode = FixedQuestionCode | ValidationFailureQuestionCode;

const VF_CODE = /^VF_R(0[1-9]|1\d|2[0-7])$/;

export function isQuestionCode(value: string): value is QuestionCode {
  return value in FIXED_QUESTION_CODES || VF_CODE.test(value);
}

export const QuestionCodeSchema = z.custom<QuestionCode>(
  (v) => typeof v === 'string' && isQuestionCode(v),
  'unknown question code',
);

export function questionKindOf(code: QuestionCode): QuestionKind {
  return code.startsWith('VF_')
    ? 'VALIDATION_FAILURE'
    : FIXED_QUESTION_CODES[code as FixedQuestionCode];
}

/**
 * What choosing an answer option does. Every option maps to exactly one typed effect.
 * There is intentionally no "override" / "accept anyway" effect: a failed rule is resolved only by
 * correcting a misread value, re-checking after the ERP was fixed, or rejecting the invoice.
 */
export const AnswerEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SET_FIELD'), path: FieldPathSchema }),
  z.object({ type: z.literal('CONFIRM_FIELD'), path: FieldPathSchema }),
  z.object({
    type: z.literal('LINK_ERP_RECORD'),
    entity: z.enum(['vendor', 'item', 'po', 'po_line']),
    erpId: ErpIdSchema,
    lineNo: z.int().positive().nullable(),
  }),
  z.object({
    type: z.literal('REQUEST_CREATION'),
    entity: z.enum(['vendor', 'item', 'grn']),
    lineNo: z.int().positive().nullable(),
  }),
  z.object({ type: z.literal('DECLARE_NON_PO') }),
  z.object({ type: z.literal('APPROVE_CREATION'), entity: z.enum(CREATION_ENTITIES) }),
  z.object({ type: z.literal('RECHECK') }),
  z.object({ type: z.literal('REJECT_INVOICE') }),
]);
export type AnswerEffect = z.infer<typeof AnswerEffectSchema>;
export type AnswerEffectType = AnswerEffect['type'];

/**
 * Checks that `effect` is permitted for a question `code` (RULES §5). Returns a reason string
 * when it is not, or null when it is.
 */
export function effectViolation(code: QuestionCode, effect: AnswerEffect): string | null {
  if (effect.type === 'REJECT_INVOICE') return null;
  const is = (ok: boolean): string | null =>
    ok ? null : `${effect.type} is not allowed for ${code}`;
  if (code.startsWith('VF_')) {
    if (effect.type === 'SET_FIELD' || effect.type === 'RECHECK') return null;
    return is(code === 'VF_R26' && effect.type === 'REQUEST_CREATION' && effect.entity === 'grn');
  }
  switch (code as FixedQuestionCode) {
    case 'MD_FIELD':
      return is(effect.type === 'SET_FIELD' || effect.type === 'CONFIRM_FIELD');
    case 'AM_VENDOR':
    case 'AM_VENDOR_PAN':
      return is(
        (effect.type === 'LINK_ERP_RECORD' && effect.entity === 'vendor') ||
          (effect.type === 'REQUEST_CREATION' && effect.entity === 'vendor'),
      );
    case 'AM_OPEN_PO':
      return is(
        (effect.type === 'LINK_ERP_RECORD' && effect.entity === 'po') ||
          effect.type === 'DECLARE_NON_PO',
      );
    case 'AM_PO_LINE':
      return is(effect.type === 'LINK_ERP_RECORD' && effect.entity === 'po_line');
    case 'AM_ITEM':
      return is(
        (effect.type === 'LINK_ERP_RECORD' && effect.entity === 'item') ||
          (effect.type === 'REQUEST_CREATION' && effect.entity === 'item'),
      );
    case 'BD_VENDOR_INACTIVE':
      return is(effect.type === 'APPROVE_CREATION' && effect.entity === 'vendor_reactivation');
    case 'BD_PO_CLOSED':
      return is(effect.type === 'RECHECK');
    case 'CA_VENDOR':
      return is(effect.type === 'APPROVE_CREATION' && effect.entity === 'vendor');
    case 'CA_ITEM':
      return is(effect.type === 'APPROVE_CREATION' && effect.entity === 'item');
    case 'CA_PO':
      return is(
        (effect.type === 'APPROVE_CREATION' && effect.entity === 'po') ||
          (effect.type === 'SET_FIELD' && effect.path === 'header.poNumber'),
      );
    case 'CA_GRN':
      return is(effect.type === 'APPROVE_CREATION' && effect.entity === 'grn');
  }
}

/** The subject key format each question code uses, so a re-run finds the same open question. */
export function subjectKeyViolation(code: QuestionCode, subjectKey: string): string | null {
  const is = (ok: boolean): string | null =>
    ok ? null : `subject key "${subjectKey}" is invalid for ${code}`;
  if (code.startsWith('VF_')) {
    const rule = code.slice(3);
    return is(new RegExp(`^${rule}(:line:[1-9]\\d*)?$`).test(subjectKey));
  }
  switch (code as FixedQuestionCode) {
    case 'MD_FIELD':
      return is(isFieldPath(subjectKey));
    case 'AM_VENDOR':
    case 'AM_VENDOR_PAN':
    case 'BD_VENDOR_INACTIVE':
    case 'CA_VENDOR':
      return is(subjectKey === 'vendor');
    case 'AM_OPEN_PO':
    case 'BD_PO_CLOSED':
    case 'CA_PO':
      return is(subjectKey === 'po');
    case 'AM_PO_LINE':
    case 'AM_ITEM':
    case 'CA_ITEM':
      return is(/^line:[1-9]\d*$/.test(subjectKey));
    case 'CA_GRN':
      return is(/^grn:.+$/.test(subjectKey));
  }
}
