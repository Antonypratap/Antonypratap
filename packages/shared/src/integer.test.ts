import { describe, expect, it } from 'vitest';
import {
  divRoundHalfUp,
  formatScaledDecimal,
  groupIndian,
  parseScaledDecimal,
  toSafeInteger,
} from './integer';

describe('divRoundHalfUp', () => {
  it.each([
    [0n, 3n, 0n],
    [1n, 3n, 0n],
    [2n, 3n, 1n],
    [5n, 2n, 3n], // exactly .5 rounds up
    [4n, 2n, 2n],
    [15n, 10n, 2n],
    [14n, 10n, 1n],
    [1499n, 1000n, 1n],
    [1500n, 1000n, 2n],
  ])('%d / %d = %d', (n, d, expected) => {
    expect(divRoundHalfUp(n, d)).toBe(expected);
  });

  it('refuses negative numerators and non-positive denominators', () => {
    expect(() => divRoundHalfUp(-1n, 2n)).toThrow(RangeError);
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(RangeError);
    expect(() => divRoundHalfUp(1n, -2n)).toThrow(RangeError);
  });
});

describe('toSafeInteger', () => {
  it('accepts the safe range and rejects beyond it', () => {
    expect(toSafeInteger(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => toSafeInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
    expect(() => toSafeInteger(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toThrow(RangeError);
  });
});

describe('parseScaledDecimal', () => {
  const p = (s: string, scale = 2, allowNegative = false) =>
    parseScaledDecimal(s, scale, { allowNegative });

  it('parses plain and grouped numbers exactly', () => {
    expect(p('0.29')).toEqual({ ok: true, value: 29 }); // 0.29 * 100 in floating point is 28.999…
    expect(p('1,13,870.00')).toEqual({ ok: true, value: 11387000 });
    expect(p('113,870.00')).toEqual({ ok: true, value: 11387000 });
    expect(p('1,00,00,000')).toEqual({ ok: true, value: 1000000000 });
    expect(p('12.5')).toEqual({ ok: true, value: 1250 });
    expect(p('7')).toEqual({ ok: true, value: 700 });
    expect(p('  42.10  ')).toEqual({ ok: true, value: 4210 });
  });

  it('rejects more decimals than the scale instead of rounding', () => {
    expect(p('12.345')).toEqual({ ok: false, error: 'too_many_decimals' });
    expect(p('12.3450')).toEqual({ ok: false, error: 'too_many_decimals' });
    expect(p('1.2345', 3)).toEqual({ ok: false, error: 'too_many_decimals' });
  });

  it('rejects malformed grouping', () => {
    for (const s of ['1,2345', '12,34,5', '1,,000', '1000,00', '11,387,0']) {
      expect(p(s)).toEqual({ ok: false, error: 'bad_grouping' });
    }
  });

  it('rejects non-numeric forms', () => {
    for (const s of ['abc', ',100', '.50', '1.', '1e5', '1 000', '+5', '0x10', '12.3.4']) {
      expect(p(s).ok).toBe(false);
    }
    expect(p('')).toEqual({ ok: false, error: 'empty' });
  });

  it('only allows negatives when asked', () => {
    expect(p('-0.50')).toEqual({ ok: false, error: 'negative_not_allowed' });
    expect(p('-0.50', 2, true)).toEqual({ ok: true, value: -50 });
    expect(p('-0', 2, false)).toEqual({ ok: true, value: 0 });
  });

  it('rejects values beyond the safe integer range', () => {
    expect(p('99999999999999999.99')).toEqual({ ok: false, error: 'out_of_range' });
  });
});

describe('formatScaledDecimal / groupIndian', () => {
  it('formats with a fixed scale', () => {
    expect(formatScaledDecimal(5, 2)).toBe('0.05');
    expect(formatScaledDecimal(-1205, 2)).toBe('-12.05');
    expect(formatScaledDecimal(12500, 3)).toBe('12.500');
    expect(formatScaledDecimal(7, 0)).toBe('7');
  });

  it('groups the Indian way', () => {
    expect(groupIndian('999')).toBe('999');
    expect(groupIndian('1000')).toBe('1,000');
    expect(groupIndian('113870')).toBe('1,13,870');
    expect(groupIndian('10000000')).toBe('1,00,00,000');
  });
});
