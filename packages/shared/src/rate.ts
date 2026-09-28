import { z } from 'zod';
import { assertSafeInteger, parseScaledDecimal, type DecimalParseError } from './integer';
import { err, ok, type Result } from './result';

/** A GST rate in basis points: 18% = 1800, 0.25% = 25. Range 0..10000 (0%..100%). */
export const RateBpSchema = z.int().min(0).max(10_000).brand<'RateBp'>();
export type RateBp = z.infer<typeof RateBpSchema>;

export const BP_PER_WHOLE = 10_000;

export function rateBp(value: number): RateBp {
  assertSafeInteger(value, 'rateBp');
  if (value < 0 || value > BP_PER_WHOLE) throw new RangeError(`rateBp out of range: ${value}`);
  return value as RateBp;
}

/** Parses "18", "18%", "18.00 %", "0.25%" into basis points. At most 2 decimals. */
export function parseRatePercent(text: string): Result<RateBp, DecimalParseError> {
  const s = text.trim().replace(/\s*%$/, '');
  if (s.includes(',')) return err('invalid_format');
  const parsed = parseScaledDecimal(s, 2, { allowNegative: false });
  if (!parsed.ok) return err(parsed.error);
  if (parsed.value > BP_PER_WHOLE) return err('out_of_range');
  return ok(parsed.value as RateBp);
}

/** 1800 → "18%", 25 → "0.25%", 250 → "2.5%". */
export function formatRate(rate: RateBp): string {
  const whole = Math.trunc(rate / 100);
  const frac = (rate % 100).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

/** Confidence of an extracted value in basis points (0..10000). Integers only, like every other measure. */
export const ConfidenceBpSchema = z.int().min(0).max(10_000).brand<'ConfidenceBp'>();
export type ConfidenceBp = z.infer<typeof ConfidenceBpSchema>;

export function confidenceBp(value: number): ConfidenceBp {
  return ConfidenceBpSchema.parse(value);
}
