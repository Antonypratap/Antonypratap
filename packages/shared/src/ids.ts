import { z } from 'zod';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ulid = () => z.string().regex(ULID, 'expected a ULID');

/** Veyra-owned identifiers are ULIDs, branded per entity so they cannot be mixed up. */
export const InvoiceIdSchema = ulid().brand<'InvoiceId'>();
export type InvoiceId = z.infer<typeof InvoiceIdSchema>;
export const DocumentIdSchema = ulid().brand<'DocumentId'>();
export type DocumentId = z.infer<typeof DocumentIdSchema>;
export const UserIdSchema = ulid().brand<'UserId'>();
export type UserId = z.infer<typeof UserIdSchema>;
export const QuestionIdSchema = ulid().brand<'QuestionId'>();
export type QuestionId = z.infer<typeof QuestionIdSchema>;
export const CreationActionIdSchema = ulid().brand<'CreationActionId'>();
export type CreationActionId = z.infer<typeof CreationActionIdSchema>;
export const AuditEventIdSchema = ulid().brand<'AuditEventId'>();
export type AuditEventId = z.infer<typeof AuditEventIdSchema>;
export const ExtractionIdSchema = ulid().brand<'ExtractionId'>();
export type ExtractionId = z.infer<typeof ExtractionIdSchema>;

/**
 * Identifiers owned by the ERP are opaque: a real ERP (Tally, Zoho, …) decides their format.
 */
export const ErpIdSchema = z.string().min(1).max(128).brand<'ErpId'>();
export type ErpId = z.infer<typeof ErpIdSchema>;

/**
 * Idempotency key for ERP writes (ARCHITECTURE §4.3):
 *   `veyra:<invoiceId>:<creationActionId>` for a staged creation, and
 *   `veyra:<invoiceId>:purchase_invoice` for recording the invoice itself, and
 *   `veyra:import:<importId>` for importing a batch of business records.
 */
export const IdempotencyKeySchema = z
  .string()
  .regex(
    /^veyra:([0-9A-HJKMNP-TV-Z]{26}:([0-9A-HJKMNP-TV-Z]{26}|purchase_invoice)|import:[0-9A-HJKMNP-TV-Z]{26})$/,
    'bad idempotency key',
  )
  .brand<'IdempotencyKey'>();
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export function creationIdempotencyKey(
  invoiceId: InvoiceId,
  actionId: CreationActionId,
): IdempotencyKey {
  return `veyra:${invoiceId}:${actionId}` as IdempotencyKey;
}

export function purchaseInvoiceIdempotencyKey(invoiceId: InvoiceId): IdempotencyKey {
  return `veyra:${invoiceId}:purchase_invoice` as IdempotencyKey;
}

export function importIdempotencyKey(importId: string): IdempotencyKey {
  return IdempotencyKeySchema.parse(`veyra:import:${importId}`);
}
