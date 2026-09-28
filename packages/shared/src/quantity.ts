import { z } from 'zod';
import {
  assertSafeInteger,
  formatScaledDecimal,
  parseScaledDecimal,
  toSafeInteger,
  type DecimalParseError,
} from './integer';
import { err, ok, type Result } from './result';

/**
 * Quantities are integer milli-units of the line's UOM (12.5 kg = 12500). At most 3 decimals
 * are representable; anything finer is unparseable, never rounded.
 */
export const MilliQtySchema = z.int().brand<'MilliQty'>();
export type MilliQty = z.infer<typeof MilliQtySchema>;

export const NonNegativeMilliQtySchema = z.int().nonnegative().brand<'MilliQty'>();
export const PositiveMilliQtySchema = z.int().positive().brand<'MilliQty'>();

export const MILLI_PER_UNIT = 1000;

export function milliQty(value: number): MilliQty {
  assertSafeInteger(value, 'milliQty');
  return value as MilliQty;
}

export const ZERO_QTY: MilliQty = milliQty(0);

const fromBig = (v: bigint): MilliQty => toSafeInteger(v, 'milliQty') as MilliQty;

export function sumQty(values: readonly MilliQty[]): MilliQty {
  return fromBig(values.reduce((acc, v) => acc + BigInt(v), 0n));
}

export function addQty(...values: MilliQty[]): MilliQty {
  return sumQty(values);
}

/** May return a negative quantity (e.g. remaining = accepted − already invoiced). */
export function subtractQty(a: MilliQty, b: MilliQty): MilliQty {
  return fromBig(BigInt(a) - BigInt(b));
}

export function compareQty(a: MilliQty, b: MilliQty): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function equalsQty(a: MilliQty, b: MilliQty): boolean {
  return a === b;
}

/** Canonical serialisation with exactly three decimals: 12500 → "12.500". */
export function qtyToDecimalString(q: MilliQty): string {
  return formatScaledDecimal(q, 3);
}

/** Display form without trailing zeros: 12500 → "12.5", 1000 → "1". */
export function formatQty(q: MilliQty): string {
  return qtyToDecimalString(q).replace(/\.?0+$/, '');
}

/** Parses a printed quantity (optional grouping, ≤ 3 decimals, non-negative). */
export function parseQuantity(text: string): Result<MilliQty, DecimalParseError> {
  const parsed = parseScaledDecimal(text, 3, { allowNegative: false });
  return parsed.ok ? ok(parsed.value as MilliQty) : err(parsed.error);
}
