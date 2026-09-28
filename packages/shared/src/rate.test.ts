import { describe, expect, it } from 'vitest';
import { ConfidenceBpSchema, RateBpSchema, formatRate, parseRatePercent, rateBp } from './rate';

describe('GST rates in basis points', () => {
  it('parse printed percentages', () => {
    expect(parseRatePercent('18%')).toEqual({ ok: true, value: 1800 });
    expect(parseRatePercent('18.00 %')).toEqual({ ok: true, value: 1800 });
    expect(parseRatePercent('0.25%')).toEqual({ ok: true, value: 25 });
    expect(parseRatePercent('12')).toEqual({ ok: true, value: 1200 });
    expect(parseRatePercent('0.125%')).toEqual({ ok: false, error: 'too_many_decimals' });
    expect(parseRatePercent('101%')).toEqual({ ok: false, error: 'out_of_range' });
    expect(parseRatePercent('1,800').ok).toBe(false);
  });

  it('format back', () => {
    expect(formatRate(rateBp(1800))).toBe('18%');
    expect(formatRate(rateBp(25))).toBe('0.25%');
    expect(formatRate(rateBp(250))).toBe('2.5%');
    expect(formatRate(rateBp(0))).toBe('0%');
  });

  it('reject out-of-range and fractional values', () => {
    expect(() => rateBp(-1)).toThrow(RangeError);
    expect(() => rateBp(10_001)).toThrow(RangeError);
    expect(RateBpSchema.safeParse(18.5).success).toBe(false);
    expect(ConfidenceBpSchema.safeParse(0.9).success).toBe(false);
    expect(ConfidenceBpSchema.safeParse(9000).success).toBe(true);
  });
});
