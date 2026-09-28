import { describe, expect, it } from 'vitest';
import {
  NonNegativeMilliQtySchema,
  PositiveMilliQtySchema,
  addQty,
  compareQty,
  equalsQty,
  formatQty,
  milliQty,
  parseQuantity,
  qtyToDecimalString,
  subtractQty,
  sumQty,
} from './quantity';

describe('milli-unit quantities', () => {
  it('construct only from safe integers', () => {
    expect(milliQty(12500)).toBe(12500);
    expect(() => milliQty(12.5)).toThrow(RangeError);
  });

  it('parse printed quantities exactly, up to 3 decimals', () => {
    expect(parseQuantity('12.5')).toEqual({ ok: true, value: 12500 });
    expect(parseQuantity('1,000')).toEqual({ ok: true, value: 1_000_000 });
    expect(parseQuantity('0.001')).toEqual({ ok: true, value: 1 });
    expect(parseQuantity('0.0005')).toEqual({ ok: false, error: 'too_many_decimals' });
    expect(parseQuantity('-5')).toEqual({ ok: false, error: 'negative_not_allowed' });
  });

  it('do the arithmetic the GRN rules need', () => {
    const accepted = sumQty([milliQty(100_000), milliQty(80_000)]);
    const invoiced = milliQty(200_000);
    const remaining = subtractQty(accepted, milliQty(0));
    expect(compareQty(invoiced, remaining)).toBe(1); // DEMO S10: 200 > 180
    expect(subtractQty(milliQty(180_000), invoiced)).toBe(-20_000);
    expect(addQty(milliQty(1), milliQty(2))).toBe(3);
    expect(equalsQty(milliQty(50_000), milliQty(50_000))).toBe(true);
    expect(equalsQty(milliQty(50_000), milliQty(50_001))).toBe(false);
  });

  it('serialise canonically and display without trailing zeros', () => {
    expect(qtyToDecimalString(milliQty(12500))).toBe('12.500');
    expect(formatQty(milliQty(12500))).toBe('12.5');
    expect(formatQty(milliQty(1_000_000))).toBe('1000');
    expect(formatQty(milliQty(0))).toBe('0');
    expect(formatQty(milliQty(1))).toBe('0.001');
  });

  it('schemas enforce sign', () => {
    expect(NonNegativeMilliQtySchema.safeParse(-1).success).toBe(false);
    expect(PositiveMilliQtySchema.safeParse(0).success).toBe(false);
    expect(PositiveMilliQtySchema.safeParse(1.5).success).toBe(false);
  });
});
