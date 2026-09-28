import { describe, expect, it } from 'vitest';
import {
  GstinSchema,
  PanSchema,
  computeGstinCheckChar,
  isValidGstin,
  validateGstin,
} from './gstin';

/** Checksum-valid GSTINs from docs/DEMO.md §1.2–1.3. */
const DEMO_VALID = [
  ['29AAACS1111A1Z6', '29'], // company
  ['29AAFCS5678K1ZK', '29'], // Shakti
  ['27AAACA4321M1ZT', '27'], // Apex
  ['29ABCPB2468Q1Z9', '29'], // Bharat
  ['33AAHCK1357R1Z3', '33'], // Kaveri
  ['29AAACV1234F1ZL', '29'], // Vasudha Traders
  ['29AAJFV2222B1ZG', '29'], // Vasudha Traders & Co
  ['29AAKCE3344D1ZP', '29'], // Eastline
  ['29AADCN9753P1ZH', '29'], // Nandi (not in ERP)
] as const;

/** Meridian Fasteners (DEMO S15): correct check character would be '2'. */
const DEMO_BAD_CHECKSUM = '29AAGCM4455J1Z5';

describe('validateGstin', () => {
  it.each(DEMO_VALID)('accepts %s', (gstin, state) => {
    const r = validateGstin(gstin);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.gstin).toBe(gstin);
      expect(r.value.stateCode).toBe(state);
      expect(r.value.pan).toBe(gstin.slice(2, 12));
      expect(r.value.entityCode).toBe(gstin.charAt(12));
    }
  });

  it('rejects the DEMO invalid checksum and reports the expected character', () => {
    expect(validateGstin(DEMO_BAD_CHECKSUM)).toEqual({
      ok: false,
      error: {
        code: 'bad_checksum',
        message: 'GSTIN checksum does not match',
        expectedCheckChar: '2',
      },
    });
  });

  it('detects every wrong check character', () => {
    const [valid] = DEMO_VALID[1];
    for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const candidate = valid.slice(0, 14) + c;
      expect(isValidGstin(candidate)).toBe(c === valid.charAt(14));
    }
  });

  it('detects single-character changes that keep the format', () => {
    expect(isValidGstin('29AAFCS5679K1ZK')).toBe(false); // digit changed
    expect(isValidGstin('29AAFCT5678K1ZK')).toBe(false); // letter changed
    expect(isValidGstin('29AAFCS5678K2ZK')).toBe(false); // entity code changed
  });

  it('reports errors in order: empty, length, format, state, checksum', () => {
    const code = (s: string) => {
      const r = validateGstin(s);
      return r.ok ? 'ok' : r.error.code;
    };
    expect(code('   ')).toBe('empty');
    expect(code('29AAFCS5678K1Z')).toBe('bad_length');
    expect(code('29AAFCS5678K1ZKX')).toBe('bad_length');
    expect(code('29AAFCS5678K1XK')).toBe('bad_format'); // 14th must be Z
    expect(code('29AAFCS5678K0ZK')).toBe('bad_format'); // 13th cannot be 0
    expect(code('2AAAFCS5678K1ZK')).toBe('bad_format');
    expect(code('29AAF CS5678K1Z')).toBe('bad_format');
    expect(code('00AAFCS5678K1ZK')).toBe('unknown_state_code');
    expect(code('40AAFCS5678K1ZK')).toBe('unknown_state_code');
  });

  it('only trims and uppercases; never corrects', () => {
    expect(validateGstin(' 29aafcs5678k1zk ').ok).toBe(true);
    expect(validateGstin('29AAFCS5678KIZK').ok).toBe(false); // I for 1 is not "fixed"
  });

  it('computes check characters', () => {
    expect(computeGstinCheckChar('29AAGCM4455J1Z')).toBe('2');
    expect(() => computeGstinCheckChar('29aagcm4455j1z')).toThrow(RangeError);
  });

  it('schemas accept only canonical valid values', () => {
    expect(GstinSchema.safeParse('27AAACA4321M1ZT').success).toBe(true);
    expect(GstinSchema.safeParse('27aaaca4321m1zt').success).toBe(false);
    expect(GstinSchema.safeParse(DEMO_BAD_CHECKSUM).success).toBe(false);
    expect(PanSchema.safeParse('AAACA4321M').success).toBe(true);
    expect(PanSchema.safeParse('AAACA4321').success).toBe(false);
  });
});
