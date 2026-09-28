import { describe, expect, it } from 'vitest';
import {
  NonNegativePaiseSchema,
  PaiseSchema,
  addPaise,
  comparePaise,
  equalsPaise,
  formatInr,
  mulDivPaiseRoundHalfUp,
  negatePaise,
  paise,
  paiseFromDecimalString,
  paiseToDecimalString,
  parseMoney,
  roundToRupeeHalfUp,
  subtractPaise,
  sumPaise,
} from './money';

describe('paise construction', () => {
  it('accepts only safe integers', () => {
    expect(paise(11387000)).toBe(11387000);
    for (const bad of [
      0.5,
      62.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => paise(bad)).toThrow(RangeError);
    }
  });

  it('schemas reject fractional and (where required) negative values', () => {
    expect(PaiseSchema.safeParse(-50).success).toBe(true);
    expect(PaiseSchema.safeParse(62.5).success).toBe(false);
    expect(PaiseSchema.safeParse('100').success).toBe(false);
    expect(NonNegativePaiseSchema.safeParse(-1).success).toBe(false);
    expect(NonNegativePaiseSchema.safeParse(0).success).toBe(true);
  });
});

describe('arithmetic is exact', () => {
  it('adds and subtracts without drift', () => {
    const tenths = Array.from({ length: 10 }, () => paise(10));
    expect(sumPaise(tenths)).toBe(100);
    expect(addPaise(paise(9650000), paise(868500), paise(868500))).toBe(11387000); // DEMO S01
    expect(subtractPaise(paise(368800), paise(368750))).toBe(50);
    expect(negatePaise(paise(50))).toBe(-50);
    expect(sumPaise([])).toBe(0);
  });

  it('refuses to overflow the safe integer range', () => {
    expect(() => addPaise(paise(Number.MAX_SAFE_INTEGER), paise(1))).toThrow(RangeError);
  });

  it('compares exactly: one paisa is a difference', () => {
    expect(equalsPaise(paise(680000), paise(680100))).toBe(false);
    expect(comparePaise(paise(680000), paise(680001))).toBe(-1);
    expect(comparePaise(paise(1), paise(1))).toBe(0);
    expect(comparePaise(paise(2), paise(1))).toBe(1);
  });
});

describe('mulDivPaiseRoundHalfUp', () => {
  it('computes price × quantity with half-up rounding', () => {
    expect(mulDivPaiseRoundHalfUp(paise(6250), 1_000_000, 1000)).toBe(6250000); // 1000 kg @ ₹62.50
    expect(mulDivPaiseRoundHalfUp(paise(1001), 1500, 1000)).toBe(1502); // 1.5 × ₹10.01 = 15.015 → 15.02
    expect(mulDivPaiseRoundHalfUp(paise(1001), 1499, 1000)).toBe(1500); // 15.00499 → 15.00
  });

  it('stays exact when the intermediate product exceeds 2^53', () => {
    const amount = paise(9_000_000_000_000); // ₹90 billion
    const result = mulDivPaiseRoundHalfUp(amount, 1800, 10_000);
    expect(result).toBe(1_620_000_000_000);
    expect(amount * 1800 > Number.MAX_SAFE_INTEGER).toBe(true);
  });

  it('refuses negative amounts and non-integer factors', () => {
    expect(() => mulDivPaiseRoundHalfUp(paise(-100), 1800, 10_000)).toThrow(RangeError);
    expect(() => mulDivPaiseRoundHalfUp(paise(100), 0.18, 1)).toThrow(RangeError);
  });
});

describe('roundToRupeeHalfUp', () => {
  it.each([
    [368750, 368800],
    [368749, 368700],
    [368700, 368700],
    [73750, 73800],
    [0, 0],
    [99, 100],
    [49, 0],
  ])('%d → %d', (input, expected) => {
    expect(roundToRupeeHalfUp(paise(input))).toBe(expected);
  });
});

describe('serialisation', () => {
  it('round-trips through the canonical decimal string', () => {
    for (const value of [0, 5, -5, 1205, -1205, 11387000]) {
      const text = paiseToDecimalString(paise(value));
      expect(paiseFromDecimalString(text)).toEqual({ ok: true, value });
    }
    expect(paiseToDecimalString(paise(11387000))).toBe('113870.00');
  });

  it('the canonical parser is strict', () => {
    for (const s of ['12.5', '12', '1,000.00', '₹12.00', '12.000', ' 12.00']) {
      expect(paiseFromDecimalString(s).ok).toBe(false);
    }
  });
});

describe('parseMoney (printed amounts)', () => {
  it('accepts Indian grouping and currency prefixes', () => {
    expect(parseMoney('1,13,870.00')).toEqual({ ok: true, value: 11387000 });
    expect(parseMoney('₹1,13,870.00')).toEqual({ ok: true, value: 11387000 });
    expect(parseMoney('₹ 16,048')).toEqual({ ok: true, value: 1604800 });
    expect(parseMoney('Rs. 612.09')).toEqual({ ok: true, value: 61209 });
    expect(parseMoney('INR 0.50')).toEqual({ ok: true, value: 50 });
  });

  it('never rounds: three decimals are unparseable', () => {
    expect(parseMoney('62.505')).toEqual({ ok: false, error: 'too_many_decimals' });
  });

  it('negative amounts only when allowed (round-off lines)', () => {
    expect(parseMoney('-0.49')).toEqual({ ok: false, error: 'negative_not_allowed' });
    expect(parseMoney('-0.49', { allowNegative: true })).toEqual({ ok: true, value: -49 });
    expect(parseMoney('₹-0.49', { allowNegative: true })).toEqual({ ok: true, value: -49 });
    expect(parseMoney('-₹0.49', { allowNegative: true })).toEqual({ ok: true, value: -49 });
    expect(parseMoney('--0.49', { allowNegative: true }).ok).toBe(false);
  });
});

describe('formatInr', () => {
  it('formats with Indian grouping', () => {
    expect(formatInr(paise(11387000))).toBe('₹1,13,870.00');
    expect(formatInr(paise(50))).toBe('₹0.50');
    expect(formatInr(paise(-49))).toBe('-₹0.49');
    expect(formatInr(paise(3468800), { symbol: false })).toBe('34,688.00');
  });
});
