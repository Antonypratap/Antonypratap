import { z } from 'zod';

/** A two-digit GST state code, e.g. "29". Whether the code exists is checked by @veyra/india-tax. */
export const StateCodeSchema = z
  .string()
  .regex(/^\d{2}$/, 'expected a 2-digit state code')
  .brand<'StateCode'>();
export type StateCode = z.infer<typeof StateCodeSchema>;

/** Arbitrary JSON detail (expected/actual values, context, payloads). */
export const JsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const LineNoSchema = z.int().positive();
