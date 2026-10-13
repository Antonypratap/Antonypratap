import { z } from 'zod';

/**
 * The ERP API connection screen (docs/ERP-API.md): the connection, its sync and what was found.
 * The profile itself is validated by `ProfileSchema` (@veyra/shared/erp-profile). No response
 * here ever carries a credential.
 */

const entity = z.enum(['vendors', 'items', 'purchase_orders', 'grns', 'bills']);

export const ApiErpSyncCountsSchema = z.object({
  received: z.number(),
  mapped: z.number(),
  changed: z.number(),
  unchanged: z.number(),
  invalid: z.number(),
  outOfScope: z.number(),
  missing: z.number(),
  pages: z.number(),
  status: z.enum(['pending', 'complete', 'untrusted', 'shape_changed', 'failed']),
});

export const ApiErpSyncRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(['manual', 'scheduled', 'before_check']),
  status: z.enum(['running', 'succeeded', 'partial', 'failed', 'interrupted']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: z.partialRecord(entity, ApiErpSyncCountsSchema),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type ApiErpSyncRun = z.infer<typeof ApiErpSyncRunSchema>;

export const ApiErpIssueSchema = z.object({
  entity,
  erpId: z.string().nullable(),
  kind: z.enum(['invalid', 'incomplete', 'orphan', 'conflict', 'shape_changed']),
  /** Field names or a short reason; never values. */
  detail: z.array(z.string()),
});
export type ApiErpIssue = z.infer<typeof ApiErpIssueSchema>;

export const ApiErpConnectionStateSchema = z.object({
  /** Whether this organization's plan includes ERP connections. */
  available: z.boolean(),
  /** Whether the person may change the connection (admins). */
  canManage: z.boolean(),
  /** Whether credentials can be saved here (VEYRA_SECRETS_KEY is set). */
  canStoreSecrets: z.boolean(),
  /** Whether the built-in Sample ERP is offered. */
  sampleErp: z.boolean(),
  presets: z.array(z.object({ id: z.string(), name: z.string() })),
  connection: z
    .object({
      profile: z.unknown(),
      active: z.boolean(),
      version: z.number(),
      updatedAt: z.string(),
    })
    .nullable(),
  /** The saved secret: which one, and when (never its value). */
  secret: z.object({ label: z.string(), savedAt: z.string().nullable() }).nullable(),
  freshness: z.object({
    fresh: z.boolean(),
    syncedAt: z.string().nullable(),
    stale: z.array(entity),
  }),
  syncing: z.boolean(),
  runs: z.array(ApiErpSyncRunSchema),
  records: z.record(z.string(), z.number()),
  issues: z.array(ApiErpIssueSchema),
});
export type ApiErpConnectionState = z.infer<typeof ApiErpConnectionStateSchema>;

const FieldFoundSchema = z.object({ path: z.string(), samples: z.array(z.string()) });

/** What one record type's first answer looks like, a proposed mapping, and a preview. */
export const ApiErpInspectSchema = z.object({
  entity,
  listPath: z.string().nullable(),
  received: z.number(),
  fields: z.array(FieldFoundSchema),
  linesPath: z.string().nullable(),
  lineFields: z.array(FieldFoundSchema),
  proposed: z.object({
    fields: z.record(z.string(), z.object({ path: z.string() })),
    lineFields: z.record(z.string(), z.object({ path: z.string() })),
  }),
  preview: z.array(
    z.object({
      ok: z.boolean(),
      erpId: z.string().nullable(),
      record: z.unknown().optional(),
      fields: z.array(z.string()).optional(),
    }),
  ),
});
export type ApiErpInspect = z.infer<typeof ApiErpInspectSchema>;

/** "Test connection": each set-up record type's first page, read and mapped (or why not). */
export const ApiErpTestSchema = z.object({
  ok: z.boolean(),
  entities: z.array(
    z.object({
      entity,
      ok: z.boolean(),
      received: z.number(),
      mapped: z.number(),
      invalid: z.number(),
      missing: z.array(z.string()),
      error: z.object({ code: z.string(), message: z.string() }).nullable(),
    }),
  ),
});
export type ApiErpTest = z.infer<typeof ApiErpTestSchema>;

export const ApiSampleInvoiceSchema = z.object({ key: z.string(), title: z.string() });
