import { z } from 'zod';
import {
  assertSafeInteger,
  divRoundHalfUp,
  formatScaledDecimal,
  groupIndian,
  parseScaledDecimal,
  toSafeInteger,
  type DecimalParseError,
} from './integer';
import { err, ok, type Result } from './result';

/**
 * Money is an integer number of paise (1 rupee = 100 paise). V1 is INR only.
 * There is no rupee-valued or floating-point representation anywhere in Veyra.
 */
export const PaiseSchema = z.int().brand<'Paise'>();
export type Paise = z.infer<typeof PaiseSchema>;

/** Paise that must be ≥ 0 (amounts, prices, taxes). Round-off is the only signed amount. */
export const NonNegativePaiseSchema = z.int().nonnegative().brand<'Paise'>();

/** Constructs a Paise value, throwing unless it is a safe integer. */
export function paise(value: number): Paise {
  assertSafeInteger(value, 'paise');
  return value as Paise;
}

export const ZERO_PAISE: Paise = paise(0);
export const PAISE_PER_RUPEE = 100;

const big = (p: Paise): bigint => BigInt(p);
const fromBig = (v: bigint): Paise => toSafeInteger(v, 'paise') as Paise;

export function sumPaise(values: readonly Paise[]): Paise {
  return fromBig(values.reduce((acc, v) => acc + big(v), 0n));
}

export function addPaise(...values: Paise[]): Paise {
  return sumPaise(values);
}

export function subtractPaise(a: Paise, b: Paise): Paise {
  return fromBig(big(a) - big(b));
}

export function negatePaise(a: Paise): Paise {
  return fromBig(-big(a));
}

export function comparePaise(a: Paise, b: Paise): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Exact equality. There is no tolerance variant. */
export function equalsPaise(a: Paise, b: Paise): boolean {
  return a === b;
}

export function isNegativePaise(a: Paise): boolean {
  return a < 0;
}

/**
 * `amount × numerator / denominator`, rounded half up to the paisa.
 * Used for price × quantity (denominator 1000) and amount × rate (denominator 10000/20000).
 * `amount` and `numerator` must be non-negative.
 */
export function mulDivPaiseRoundHalfUp(
  amount: Paise,
  numerator: number,
  denominator: number,
): Paise {
  assertSafeInteger(numerator, 'numerator');
  assertSafeInteger(denominator, 'denominator');
  return fromBig(divRoundHalfUp(big(amount) * BigInt(numerator), BigInt(denominator)));
}

/** Rounds a non-negative amount to the nearest whole rupee, half up (x.50 → x+1). */
export function roundToRupeeHalfUp(amount: Paise): Paise {
  const rupees = divRoundHalfUp(big(amount), BigInt(PAISE_PER_RUPEE));
  return fromBig(rupees * BigInt(PAISE_PER_RUPEE));
}

/** Canonical serialisation: plain decimal rupees with exactly two decimals, e.g. "-12.05". */
export function paiseToDecimalString(amount: Paise): string {
  return formatScaledDecimal(amount, 2);
}

/** Strict inverse of {@link paiseToDecimalString}: `^-?\d+\.\d{2}$`, no grouping, no symbol. */
export function paiseFromDecimalString(text: string): Result<Paise, DecimalParseError> {
  if (!/^-?\d+\.\d{2}$/.test(text)) return err('invalid_format');
  const parsed = parseScaledDecimal(text, 2, { allowNegative: true });
  return parsed.ok ? ok(parsed.value as Paise) : err(parsed.error);
}

/**
 * Parses money as printed on an invoice: optional `₹` / `Rs.` / `INR` prefix, optional sign,
 * Indian or western digit grouping, at most 2 decimals (more is an error, never rounded).
 */
export function parseMoney(
  text: string,
  options: { allowNegative?: boolean } = {},
): Result<Paise, DecimalParseError> {
  let s = text.trim();
  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).trimStart();
  }
  s = s.replace(/^(₹|rs\.?|inr)\s*/i, '');
  if (s.startsWith('-')) {
    if (negative) return err('invalid_format');
    negative = true;
    s = s.slice(1);
  }
  const parsed = parseScaledDecimal(negative ? `-${s}` : s, 2, {
    allowNegative: options.allowNegative ?? false,
  });
  return parsed.ok ? ok(parsed.value as Paise) : err(parsed.error);
}

/** Display formatting with Indian grouping: 11387000 → "₹1,13,870.00". */
export function formatInr(amount: Paise, options: { symbol?: boolean } = {}): string {
  const plain = paiseToDecimalString(amount);
  const negative = plain.startsWith('-');
  const [intPart = '0', fracPart = '00'] = plain.replace('-', '').split('.');
  const symbol = options.symbol === false ? '' : '₹';
  return `${negative ? '-' : ''}${symbol}${groupIndian(intPart)}.${fracPart}`;
}
