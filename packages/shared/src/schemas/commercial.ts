import { z } from 'zod';
import {
  CAPABILITY_KEYS,
  COMMERCIAL_EVENTS,
  COMMERCIAL_STATUSES,
  PLAN_STATUSES,
  type CapabilityKey,
} from '../commercial';

/** Wire contract for commercial entitlements and Veyra Operations (Phase 8A). */
const CapabilityKeySchema = z.enum(CAPABILITY_KEYS as [CapabilityKey, ...CapabilityKey[]]);

export const EntitlementValueSchema = z.union([
  z.object({ enabled: z.boolean() }).strict(),
  z.object({ limit: z.number().int().nonnegative().nullable() }).strict(),
]);

/**
 * What a customer's user sees: availability, and usage against a limit. Never the plan, overrides,
 * reasons or who changed what (that is Veyra's business, not the customer user's).
 */
export const ApiCapabilitiesSchema = z.object({
  capabilities: z.array(
    z.object({
      key: CapabilityKeySchema,
      name: z.string(),
      type: z.enum(['BOOLEAN', 'LIMIT']),
      available: z.boolean(),
      /** LIMIT: the quota (null = unlimited). */
      limit: z.number().nullable().optional(),
      /** LIMIT: what is used now. */
      used: z.number().nullable().optional(),
    }),
  ),
});
export type ApiCapabilities = z.infer<typeof ApiCapabilitiesSchema>;

export const ApiUsageSchema = z.object({
  /** The calendar month counted (UTC), ISO dates. */
  month: z.object({ from: z.string(), to: z.string() }),
  invoicesThisMonth: z.number(),
  invoicesTotal: z.number(),
  /** Invoices by where they are now (all time). */
  invoicesByOutcome: z.object({
    processing: z.number(),
    needsDecision: z.number(),
    verified: z.number(),
    rejected: z.number(),
    failed: z.number(),
  }),
  /** Documents read with OCR (photos and scans) this month. */
  ocrThisMonth: z.number(),
  /** Confirmed ERP writes this month. */
  erpWritesThisMonth: z.number(),
  storageBytes: z.number(),
  activeUsers: z.number(),
});
export type ApiUsage = z.infer<typeof ApiUsageSchema>;

export const ApiOpsEntitlementSchema = z.object({
  capability: CapabilityKeySchema,
  name: z.string(),
  description: z.string(),
  category: z.string(),
  type: z.enum(['BOOLEAN', 'LIMIT']),
  unit: z.string().nullable(),
  plan: EntitlementValueSchema.nullable(),
  override: z
    .object({
      value: EntitlementValueSchema,
      reason: z.string(),
      expiresAt: z.string().nullable(),
      expired: z.boolean(),
      setBy: z.string().nullable(),
      setAt: z.string(),
    })
    .nullable(),
  effective: EntitlementValueSchema,
  source: z.enum(['override', 'plan', 'none']),
  /** LIMIT: current usage, for "usage vs limit". */
  used: z.number().nullable(),
});
export type ApiOpsEntitlement = z.infer<typeof ApiOpsEntitlementSchema>;

export const ApiOpsOrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  commercialStatus: z.enum(COMMERCIAL_STATUSES),
  plan: z.object({ key: z.string(), name: z.string() }).nullable(),
  planAssignedAt: z.string().nullable(),
  createdAt: z.string(),
  /** Payment provider: none is integrated yet (Phase 8A). */
  billing: z.literal('not_configured'),
});
export type ApiOpsOrganization = z.infer<typeof ApiOpsOrganizationSchema>;

export const ApiOpsCommercialSchema = z.object({
  organization: ApiOpsOrganizationSchema,
  entitlements: z.array(ApiOpsEntitlementSchema),
  usage: ApiUsageSchema,
});
export type ApiOpsCommercial = z.infer<typeof ApiOpsCommercialSchema>;

export const ApiOpsPlanSchema = z.object({
  key: z.string(),
  name: z.string(),
  status: z.enum(PLAN_STATUSES),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  organizations: z.number(),
  entitlements: z.array(
    z.object({ capability: CapabilityKeySchema, value: EntitlementValueSchema.nullable() }),
  ),
});
export type ApiOpsPlan = z.infer<typeof ApiOpsPlanSchema>;

export const ApiCommercialEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  event: z.enum(COMMERCIAL_EVENTS),
  organizationId: z.string().nullable(),
  planKey: z.string().nullable(),
  capability: z.string().nullable(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
  reason: z.string(),
  expiresAt: z.string().nullable(),
  actor: z.string().nullable(),
  requestId: z.string().nullable(),
});
export type ApiCommercialEvent = z.infer<typeof ApiCommercialEventSchema>;
