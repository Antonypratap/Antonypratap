import { z } from 'zod';
import { MATCH_ENTITIES, MATCH_METHODS, MATCH_METHODS_BY_ENTITY, MATCH_OUTCOMES } from '../enums';
import { ErpIdSchema, InvoiceIdSchema } from '../ids';
import { LineNoSchema } from './common';

/**
 * Result of one FIND step (RULES §2). Only `found` is ever used automatically, so its shape is
 * strict: exactly one candidate, and it is the chosen one.
 */
export const MatchResultSchema = z
  .object({
    invoiceId: InvoiceIdSchema,
    runNo: z.int().positive(),
    entity: z.enum(MATCH_ENTITIES),
    lineNo: LineNoSchema.nullable(),
    outcome: z.enum(MATCH_OUTCOMES),
    method: z.enum(MATCH_METHODS),
    candidates: z.array(ErpIdSchema),
    chosenErpId: ErpIdSchema.nullable(),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (!(MATCH_METHODS_BY_ENTITY[m.entity] as readonly string[]).includes(m.method)) {
      issue(`method ${m.method} does not apply to ${m.entity}`);
    }
    if ((m.entity === 'item') !== (m.lineNo !== null))
      issue('lineNo is required for items and only for items');
    if (new Set(m.candidates).size !== m.candidates.length) issue('candidates must be unique');
    switch (m.outcome) {
      case 'found':
        if (m.candidates.length !== 1 || m.chosenErpId !== m.candidates[0]) {
          issue('found means exactly one candidate, which is the chosen one');
        }
        break;
      case 'not_found':
        if (m.candidates.length !== 0 || m.chosenErpId !== null)
          issue('not_found has no candidates');
        break;
      case 'ambiguous':
        if (m.candidates.length < 2 || m.chosenErpId !== null) {
          issue('ambiguous means two or more candidates and nothing chosen');
        }
        break;
    }
  });
export type MatchResult = z.infer<typeof MatchResultSchema>;
