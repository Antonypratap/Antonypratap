import { z } from 'zod';
import { IsoDateTimeSchema } from '../dates';
import { AUDIT_ACTOR_TYPES, AUDIT_EVENTS, INVOICE_STATES } from '../enums';
import { AuditEventIdSchema, InvoiceIdSchema, UserIdSchema } from '../ids';
import { JsonObjectSchema } from './common';

/** One append-only audit row. User actions always name the user; state changes name both states. */
export const AuditEventSchema = z
  .object({
    id: AuditEventIdSchema,
    invoiceId: InvoiceIdSchema.nullable(),
    actorType: z.enum(AUDIT_ACTOR_TYPES),
    actorUserId: UserIdSchema.nullable(),
    event: z.enum(AUDIT_EVENTS),
    fromState: z.enum(INVOICE_STATES).nullable(),
    toState: z.enum(INVOICE_STATES).nullable(),
    detail: JsonObjectSchema,
    createdAt: IsoDateTimeSchema,
  })
  .superRefine((e, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if ((e.actorType === 'user') !== (e.actorUserId !== null))
      issue('actorUserId is set exactly for user actors');
    const isTransition = e.event === 'invoice.state_changed';
    if (isTransition && (e.fromState === null || e.toState === null))
      issue('state changes record from and to');
    if (!isTransition && (e.fromState !== null || e.toState !== null))
      issue('only state changes record states');
    if (e.event !== 'settings.changed' && e.invoiceId === null)
      issue('invoice events reference the invoice');
  });
export type AuditEvent = z.infer<typeof AuditEventSchema>;
