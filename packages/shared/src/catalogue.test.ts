import { describe, expect, it } from 'vitest';
import { CREATION_POLICIES } from './enums';
import { isFieldPath, linePath } from './fields';
import {
  AnswerEffectSchema,
  effectViolation,
  isQuestionCode,
  questionKindOf,
  subjectKeyViolation,
} from './questions';
import { RULES, RULE_CODES, failureQuestionFor, isNaReasonAllowed } from './rules';

describe('rule catalogue (RULES §4.2)', () => {
  it('has R01..R27 exactly', () => {
    expect(RULE_CODES).toEqual(
      Array.from({ length: 27 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('assigns gating stages as documented', () => {
    const stageOf = (code: keyof typeof RULES) => RULES[code].stage;
    expect(RULE_CODES.filter((c) => stageOf(c) === 1)).toEqual([
      'R01',
      'R02',
      'R03',
      'R04',
      'R05',
      'R06',
      'R07',
      'R08',
      'R09',
      'R10',
      'R11',
    ]);
    expect(RULE_CODES.filter((c) => stageOf(c) === 2)).toEqual(['R12', 'R13']);
    expect(RULE_CODES.filter((c) => stageOf(c) === 4)).toEqual(['R25', 'R26']);
    expect(stageOf('R27')).toBe(3);
  });

  it('only R10 and R21–R24 may be not_applicable, each for its own reason', () => {
    const allowed = RULE_CODES.filter((c) => RULES[c].allowedNaReasons.length > 0);
    expect(allowed).toEqual(['R10', 'R21', 'R22', 'R23', 'R24']);
    expect(isNaReasonAllowed('R21', 'PO_DERIVED_FROM_INVOICE')).toBe(true);
    expect(isNaReasonAllowed('R21', 'NO_ROUND_OFF_LINE')).toBe(false);
    expect(isNaReasonAllowed('R10', 'NO_ROUND_OFF_LINE')).toBe(true);
    expect(isNaReasonAllowed('R26', 'PO_DERIVED_FROM_INVOICE')).toBe(false); // GRN is never waived
  });

  it('maps failures to the documented questions', () => {
    expect(failureQuestionFor('R13')).toBe('BD_VENDOR_INACTIVE');
    expect(failureQuestionFor('R19')).toBe('BD_PO_CLOSED');
    expect(failureQuestionFor('R25')).toBe('CA_GRN');
    expect(failureQuestionFor('R21')).toBe('VF_R21');
  });
});

describe('creation policies (RULES §3)', () => {
  it('never allow GRN, item or reactivation by auto policy', () => {
    const auto = Object.values(CREATION_POLICIES)
      .filter((p) => p.trigger === 'auto_policy')
      .map((p) => p.entity);
    expect(auto.sort()).toEqual(['alias', 'po', 'vendor']);
  });
});

describe('field paths', () => {
  it('accept known header and 1-based line fields', () => {
    expect(isFieldPath('header.totalPaise')).toBe(true);
    expect(isFieldPath('lines[1].unitPricePaise')).toBe(true);
    expect(isFieldPath('lines[0].unitPricePaise')).toBe(false);
    expect(isFieldPath('lines[01].qtyMilli')).toBe(false);
    expect(isFieldPath('header.unknownField')).toBe(false);
    expect(isFieldPath('lines[2].vendorGstin')).toBe(false);
    expect(linePath(3, 'hsnSac')).toBe('lines[3].hsnSac');
    expect(() => linePath(0, 'hsnSac')).toThrow(RangeError);
  });
});

describe('question catalogue (RULES §5)', () => {
  it('derives kinds from codes', () => {
    expect(questionKindOf('MD_FIELD')).toBe('MISSING_DATA');
    expect(questionKindOf('AM_OPEN_PO')).toBe('AMBIGUOUS_MATCH');
    expect(questionKindOf('BD_PO_CLOSED')).toBe('BUSINESS_DECISION');
    expect(questionKindOf('VF_R21')).toBe('VALIDATION_FAILURE');
    expect(questionKindOf('CA_GRN')).toBe('CREATION_APPROVAL');
  });

  it('recognises only real codes', () => {
    expect(isQuestionCode('VF_R01')).toBe(true);
    expect(isQuestionCode('VF_R27')).toBe(true);
    for (const bad of ['VF_R00', 'VF_R28', 'VF_R1', 'CA_INVOICE', 'md_field']) {
      expect(isQuestionCode(bad)).toBe(false);
    }
  });

  it('has no override effect of any kind', () => {
    for (const type of ['OVERRIDE', 'ACCEPT_ANYWAY', 'WAIVE_RULE', 'PAY']) {
      expect(AnswerEffectSchema.safeParse({ type }).success).toBe(false);
    }
  });

  it('restricts validation-failure answers to correct / re-check / reject', () => {
    expect(
      effectViolation('VF_R21', { type: 'SET_FIELD', path: 'lines[1].unitPricePaise' }),
    ).toBeNull();
    expect(effectViolation('VF_R21', { type: 'RECHECK' })).toBeNull();
    expect(effectViolation('VF_R21', { type: 'REJECT_INVOICE' })).toBeNull();
    expect(effectViolation('VF_R21', { type: 'APPROVE_CREATION', entity: 'po' })).not.toBeNull();
    expect(
      effectViolation('VF_R21', { type: 'REQUEST_CREATION', entity: 'grn', lineNo: null }),
    ).not.toBeNull();
    expect(
      effectViolation('VF_R26', { type: 'REQUEST_CREATION', entity: 'grn', lineNo: null }),
    ).toBeNull();
    expect(
      effectViolation('VF_R26', { type: 'REQUEST_CREATION', entity: 'vendor', lineNo: null }),
    ).not.toBeNull();
  });

  it('lets a GRN come only from CA_GRN approval (or a VF_R26 request that leads to it)', () => {
    expect(effectViolation('CA_GRN', { type: 'APPROVE_CREATION', entity: 'grn' })).toBeNull();
    expect(effectViolation('CA_PO', { type: 'APPROVE_CREATION', entity: 'grn' })).not.toBeNull();
    expect(effectViolation('MD_FIELD', { type: 'APPROVE_CREATION', entity: 'grn' })).not.toBeNull();
  });

  it('CA_PO accepts a PO number but no other field', () => {
    expect(effectViolation('CA_PO', { type: 'SET_FIELD', path: 'header.poNumber' })).toBeNull();
    expect(
      effectViolation('CA_PO', { type: 'SET_FIELD', path: 'header.totalPaise' }),
    ).not.toBeNull();
  });

  it('entity-specific links', () => {
    const link = (entity: 'vendor' | 'item' | 'po' | 'po_line') =>
      ({ type: 'LINK_ERP_RECORD', entity, erpId: 'x', lineNo: null }) as never;
    expect(effectViolation('AM_VENDOR', link('vendor'))).toBeNull();
    expect(effectViolation('AM_VENDOR', link('item'))).not.toBeNull();
    expect(effectViolation('AM_OPEN_PO', { type: 'DECLARE_NON_PO' })).toBeNull();
    expect(effectViolation('AM_PO_LINE', link('po'))).not.toBeNull();
    expect(
      effectViolation('BD_VENDOR_INACTIVE', {
        type: 'APPROVE_CREATION',
        entity: 'vendor_reactivation',
      }),
    ).toBeNull();
    expect(
      effectViolation('BD_PO_CLOSED', { type: 'APPROVE_CREATION', entity: 'po' }),
    ).not.toBeNull();
  });

  it('checks subject keys per code', () => {
    expect(subjectKeyViolation('MD_FIELD', 'header.placeOfSupply')).toBeNull();
    expect(subjectKeyViolation('MD_FIELD', 'vendor')).not.toBeNull();
    expect(subjectKeyViolation('AM_ITEM', 'line:2')).toBeNull();
    expect(subjectKeyViolation('AM_ITEM', 'line:0')).not.toBeNull();
    expect(subjectKeyViolation('VF_R21', 'R21:line:1')).toBeNull();
    expect(subjectKeyViolation('VF_R21', 'R22:line:1')).not.toBeNull();
    expect(subjectKeyViolation('VF_R11', 'R11')).toBeNull();
    expect(subjectKeyViolation('CA_GRN', 'grn:PO-2026-0104')).toBeNull();
    expect(subjectKeyViolation('CA_PO', 'vendor')).not.toBeNull();
  });
});
