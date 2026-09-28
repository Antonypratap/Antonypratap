import { describe, expect, it } from 'vitest';
import { isoDate } from '@veyra/shared';
import { FinancialYearSchema, financialYearOf } from './fy';
import { isValidHsnSac } from './hsn';
import { GST_STATES, isGstStateCode, resolveStateCode, stateName } from './states';

describe('GST state codes', () => {
  it('contains 01–38, 97 and 99 and nothing else', () => {
    const codes: string[] = GST_STATES.map((s) => s.code);
    const expected = [
      ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')),
      '97',
      '99',
    ];
    expect(codes).toEqual(expected);
    for (const bad of ['00', '39', '40', '96', '98', '1', '029'])
      expect(isGstStateCode(bad)).toBe(false);
  });

  it('names the DEMO states', () => {
    expect(stateName('29' as never)).toBe('Karnataka');
    expect(stateName('27' as never)).toBe('Maharashtra');
    expect(stateName('33' as never)).toBe('Tamil Nadu');
  });
});

describe('resolveStateCode', () => {
  const code = (s: string) => {
    const r = resolveStateCode(s);
    return r.ok ? r.value : `error:${r.error}`;
  };

  it('accepts code, name, or both when they agree', () => {
    expect(code('29')).toBe('29');
    expect(code('Karnataka')).toBe('29');
    expect(code('Karnataka (29)')).toBe('29');
    expect(code('29-Karnataka')).toBe('29');
    expect(code('Karnataka, State Code: 29')).toBe('29');
    expect(code('Place of Supply: Tamil Nadu')).toBe('33');
    expect(code('  tamil   NADU ')).toBe('33');
    expect(code('Jammu & Kashmir')).toBe('01');
  });

  it('knows former official names but does no fuzzy matching', () => {
    expect(code('Orissa')).toBe('21');
    expect(code('Pondicherry')).toBe('34');
    expect(code('Andhra Pradesh')).toBe('37');
    expect(code('Karnatak')).toBe('error:unknown_state');
    expect(code('Bangalore')).toBe('error:unknown_state');
  });

  it('refuses contradictions and unknown codes', () => {
    expect(code('Karnataka (33)')).toBe('error:code_name_mismatch');
    expect(code('29 / 33')).toBe('error:multiple_codes');
    expect(code('45')).toBe('error:unknown_state');
    expect(code('')).toBe('error:empty');
  });
});

describe('isValidHsnSac', () => {
  it('accepts 4, 6 or 8 digits only', () => {
    for (const ok of ['7214', '721420', '72142000', '998314']) expect(isValidHsnSac(ok)).toBe(true);
    for (const bad of ['721', '72142', '7214200', '721420001', '72A4', ' 7214', ''])
      expect(isValidHsnSac(bad)).toBe(false);
  });
});

describe('financialYearOf', () => {
  it('switches on 1 April', () => {
    expect(financialYearOf(isoDate('2026-03-31'))).toBe('2025-26');
    expect(financialYearOf(isoDate('2026-04-01'))).toBe('2026-27');
    expect(financialYearOf(isoDate('2026-09-15'))).toBe('2026-27');
    expect(financialYearOf(isoDate('2027-01-10'))).toBe('2026-27');
    expect(financialYearOf(isoDate('1999-04-01'))).toBe('1999-00');
  });

  it('schema requires consecutive years', () => {
    expect(FinancialYearSchema.safeParse('2026-27').success).toBe(true);
    expect(FinancialYearSchema.safeParse('1999-00').success).toBe(true);
    expect(FinancialYearSchema.safeParse('2026-28').success).toBe(false);
    expect(FinancialYearSchema.safeParse('2026-2027').success).toBe(false);
  });
});
