import { z } from 'zod';
import { IsoDateTimeSchema } from '../dates';
import {
  CREATION_ACTION_STATUSES,
  CREATION_ENTITIES,
  CREATION_POLICIES,
  CREATION_POLICY_CODES,
  CREATION_TRIGGERS,
} from '../enums';
import {
  CreationActionIdSchema,
  ErpIdSchema,
  IdempotencyKeySchema,
  InvoiceIdSchema,
  QuestionIdSchema,
  UserIdSchema,
  creationIdempotencyKey,
} from '../ids';
import { JsonObjectSchema } from './common';

/**
 * A staged ERP write (ARCHITECTURE §4.3, RULES §3). Nothing reaches the ERP until commit.
 * Invariants: the policy matches entity and trigger (so a GRN or item can never be auto-created),
 * approvals record the user, and only committed actions carry an ERP id.
 */
export const CreationActionSchema = z
  .object({
    id: CreationActionIdSchema,
    invoiceId: InvoiceIdSchema,
    entity: z.enum(CREATION_ENTITIES),
    payload: JsonObjectSchema,
    policyCode: z.enum(CREATION_POLICY_CODES),
    trigger: z.enum(CREATION_TRIGGERS),
    approvedByUserId: UserIdSchema.nullable(),
    questionId: QuestionIdSchema.nullable(),
    status: z.enum(CREATION_ACTION_STATUSES),
    erpId: ErpIdSchema.nullable(),
    idempotencyKey: IdempotencyKeySchema,
    createdAt: IsoDateTimeSchema,
    committedAt: IsoDateTimeSchema.nullable(),
  })
  .superRefine((a, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    const policy = CREATION_POLICIES[a.policyCode];
    if (policy.entity !== a.entity) issue(`${a.policyCode} cannot create ${a.entity}`);
    if (policy.trigger !== a.trigger) issue(`${a.policyCode} requires trigger ${policy.trigger}`);
    if (a.trigger === 'user_approval' && (a.approvedByUserId === null || a.questionId === null)) {
      issue('user approvals record the approving user and question');
    }
    if (a.trigger === 'auto_policy' && a.approvedByUserId !== null)
      issue('auto-policy actions have no approver');
    const committed = a.status === 'committed';
    if (committed !== (a.erpId !== null) || committed !== (a.committedAt !== null)) {
      issue('erpId and committedAt are set exactly when the action is committed');
    }
    if (a.idempotencyKey !== creationIdempotencyKey(a.invoiceId, a.id)) {
      issue('idempotencyKey must be veyra:<invoiceId>:<actionId>');
    }
  });
export type CreationAction = z.infer<typeof CreationActionSchema>;
