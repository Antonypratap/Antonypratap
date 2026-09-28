import { z } from 'zod';
import type { IsoDate } from '@veyra/shared';

/** Indian financial year, 1 April – 31 March, written "2026-27". */
export type FinancialYear = string & z.$brand<'FinancialYear'>;

export const FinancialYearSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine(
    (v) => (Number(v.slice(0, 4)) + 1) % 100 === Number(v.slice(5)),
    'years must be consecutive',
  )
  .transform((v) => v as FinancialYear);

export function financialYearOf(date: IsoDate): FinancialYear {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}` as FinancialYear;
}
