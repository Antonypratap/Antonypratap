import { z } from 'zod';

/** A calendar date `YYYY-MM-DD` that actually exists (2026-02-30 is rejected). */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isRealCalendarDate, 'not a real calendar date')
  .brand<'IsoDate'>();
export type IsoDate = z.infer<typeof IsoDateSchema>;

/** An ISO-8601 UTC timestamp, e.g. `2026-09-28T04:26:39.000Z`. */
export const IsoDateTimeSchema = z.iso.datetime().brand<'IsoDateTime'>();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isoDate(value: string): IsoDate {
  return IsoDateSchema.parse(value);
}

/** Lexicographic order of `YYYY-MM-DD` is chronological order. */
export function compareIsoDate(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
