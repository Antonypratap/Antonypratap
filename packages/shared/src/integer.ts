/**
 * Exact integer helpers. All domain arithmetic (paise, milli-units, basis points) goes through
 * BigInt intermediates so products never lose precision, and results are checked to be safe
 * JavaScript integers before they are handed back as numbers.
 */

/** Throws unless `value` is a safe integer. */
export function assertSafeInteger(value: number, label = 'value'): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer, got ${String(value)}`);
  }
}

/** Converts a BigInt back to a number, refusing anything outside the safe integer range. */
export function toSafeInteger(value: bigint, label = 'value'): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${label} ${value.toString()} is outside the safe integer range`);
  }
  return Number(value);
}

/**
 * `numerator / denominator` rounded half up (x.5 → x+1).
 *
 * Only defined for a non-negative numerator and positive denominator: every place the rules use
 * "round half up" (line amounts, tax, rupee rounding) operates on non-negative amounts, and
 * refusing negatives avoids silently choosing a convention for them.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  if (numerator < 0n) throw new RangeError('numerator must be non-negative');
  return (2n * numerator + denominator) / (2n * denominator);
}

const GROUPED_INDIAN = /^\d{1,2}(,\d{2})*,\d{3}$/;
const GROUPED_WESTERN = /^\d{1,3}(,\d{3})+$/;

export type DecimalParseError =
  | 'empty'
  | 'invalid_format'
  | 'bad_grouping'
  | 'too_many_decimals'
  | 'negative_not_allowed'
  | 'out_of_range';

/**
 * Parses a decimal string into an integer count of `10^-scale` units without floating point.
 * Accepts an optional leading minus, digit grouping with commas (Indian `1,13,870` or western
 * `113,870`, validated), and at most `scale` fractional digits. More fractional digits are an
 * error, never rounded.
 */
export function parseScaledDecimal(
  text: string,
  scale: number,
  options: { allowNegative: boolean },
): { ok: true; value: number } | { ok: false; error: DecimalParseError } {
  let s = text.trim();
  if (s === '') return { ok: false, error: 'empty' };
  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  const match = /^(\d[\d,]*)(?:\.(\d+))?$/.exec(s);
  if (!match) return { ok: false, error: 'invalid_format' };
  const intPart = match[1] ?? '';
  const fracPart = match[2] ?? '';
  if (intPart.includes(',') && !GROUPED_INDIAN.test(intPart) && !GROUPED_WESTERN.test(intPart)) {
    return { ok: false, error: 'bad_grouping' };
  }
  if (fracPart.length > scale) return { ok: false, error: 'too_many_decimals' };
  const digits = intPart.replaceAll(',', '') + fracPart.padEnd(scale, '0');
  let value = BigInt(digits);
  if (negative && value !== 0n) {
    if (!options.allowNegative) return { ok: false, error: 'negative_not_allowed' };
    value = -value;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    return { ok: false, error: 'out_of_range' };
  }
  return { ok: true, value: Number(value) };
}

/** Formats an integer count of `10^-scale` units as a plain decimal string, e.g. (-1205, 2) → "-12.05". */
export function formatScaledDecimal(value: number, scale: number): string {
  assertSafeInteger(value);
  const negative = value < 0;
  const digits = Math.abs(value)
    .toString()
    .padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${intPart}${fracPart}`;
}

/** Groups an unsigned digit string the Indian way: 11387000 → "1,13,87,000". */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+$)/g, ',')},${last3}`;
}
