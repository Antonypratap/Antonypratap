import { z } from 'zod';
import { IsoDateTimeSchema } from '../dates';
import { QUESTION_KINDS, QUESTION_STATUSES } from '../enums';
import { InvoiceIdSchema, QuestionIdSchema, UserIdSchema } from '../ids';
import {
  AnswerEffectSchema,
  QuestionCodeSchema,
  effectViolation,
  questionKindOf,
  subjectKeyViolation,
} from '../questions';
import { JsonObjectSchema } from './common';

export const QuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  effect: AnswerEffectSchema,
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionAnswerSchema = z.object({
  optionId: z.string().min(1),
  input: z.json().nullable(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

/**
 * A question for the designated user (RULES §5). Invariants enforced here:
 * kind matches code, subject key matches code, every option's effect is allowed for the code,
 * option ids are unique, a reject option always exists, and answer fields match the status.
 */
export const QuestionSchema = z
  .object({
    id: QuestionIdSchema,
    invoiceId: InvoiceIdSchema,
    kind: z.enum(QUESTION_KINDS),
    code: QuestionCodeSchema,
    subjectKey: z.string().min(1),
    prompt: z.string().min(1),
    context: JsonObjectSchema,
    options: z.array(QuestionOptionSchema).min(1),
    inputSchema: z.json().nullable(),
    status: z.enum(QUESTION_STATUSES),
    assignedToUserId: UserIdSchema,
    answer: QuestionAnswerSchema.nullable(),
    answeredByUserId: UserIdSchema.nullable(),
    answeredAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .superRefine((q, ctx) => {
    const issue = (path: (string | number)[], message: string): void =>
      ctx.addIssue({ code: 'custom', path, message });

    if (q.kind !== questionKindOf(q.code))
      issue(['kind'], `${q.code} is a ${questionKindOf(q.code)} question`);
    const subject = subjectKeyViolation(q.code, q.subjectKey);
    if (subject) issue(['subjectKey'], subject);

    const ids = new Set<string>();
    q.options.forEach((option, i) => {
      if (ids.has(option.id)) issue(['options', i, 'id'], `duplicate option id ${option.id}`);
      ids.add(option.id);
      const violation = effectViolation(q.code, option.effect);
      if (violation) issue(['options', i, 'effect'], violation);
    });
    if (!q.options.some((o) => o.effect.type === 'REJECT_INVOICE')) {
      issue(['options'], 'every question offers a reject option');
    }

    const answered = q.status === 'answered';
    const hasAnswer = q.answer !== null && q.answeredByUserId !== null && q.answeredAt !== null;
    const hasNoAnswer = q.answer === null && q.answeredByUserId === null && q.answeredAt === null;
    if (answered && !hasAnswer)
      issue(['answer'], 'answered questions record answer, user and time');
    if (!answered && !hasNoAnswer) issue(['answer'], 'only answered questions carry an answer');
    if (q.answer && !ids.has(q.answer.optionId))
      issue(['answer', 'optionId'], 'answer must pick an existing option');
  });
export type Question = z.infer<typeof QuestionSchema>;
