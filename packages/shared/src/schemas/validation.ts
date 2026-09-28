import { z } from 'zod';
import { IsoDateTimeSchema } from '../dates';
import { VALIDATION_OUTCOMES } from '../enums';
import { InvoiceIdSchema } from '../ids';
import { NA_REASONS, RULE_CODES, isNaReasonAllowed } from '../rules';
import { LineNoSchema } from './common';

/** Outcome of one rule on one pipeline run (RULES §4). */
export const ValidationResultSchema = z
  .object({
    invoiceId: InvoiceIdSchema,
    runNo: z.int().positive(),
    ruleCode: z.enum(RULE_CODES),
    lineNo: LineNoSchema.nullable(),
    outcome: z.enum(VALIDATION_OUTCOMES),
    naReason: z.enum(NA_REASONS).nullable(),
    expected: z.json().nullable(),
    actual: z.json().nullable(),
    message: z.string(),
    createdAt: IsoDateTimeSchema,
  })
  .superRefine((r, ctx) => {
    if (r.outcome === 'not_applicable') {
      if (r.naReason === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['naReason'],
          message: 'not_applicable requires a reason',
        });
      } else if (!isNaReasonAllowed(r.ruleCode, r.naReason)) {
        ctx.addIssue({
          code: 'custom',
          path: ['naReason'],
          message: `${r.naReason} is not an allowed reason for ${r.ruleCode}`,
        });
      }
    } else if (r.naReason !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['naReason'],
        message: 'only not_applicable carries a reason',
      });
    }
  });
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
