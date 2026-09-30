import { z } from 'zod';
import {
  ApiCommercialEventSchema,
  ApiOpsCommercialSchema,
  ApiOpsOrganizationSchema,
  ApiOpsPlanSchema,
  type CommercialStatus,
  type EntitlementValue,
} from '@veyra/shared';
import { json, request } from '../product/api/client';

/**
 * Veyra Operations' calls (Phase 8A): `/api/v1/ops/*`, which only a VEYRA_ADMIN session may use.
 * Every change carries a reason; the server validates and audits it.
 */
const Loose = z.record(z.string(), z.unknown());

export const opsApi = {
  overview: () => request(Loose, '/ops/overview'),
  organizations: () => request(z.array(ApiOpsOrganizationSchema), '/ops/organizations'),
  commercial: (id: string) =>
    request(ApiOpsCommercialSchema, `/ops/organizations/${encodeURIComponent(id)}/commercial`),
  assignPlan: (
    id: string,
    body: { planKey: string; reason: string; commercialStatus?: CommercialStatus },
  ) =>
    request(
      ApiOpsCommercialSchema,
      `/ops/organizations/${encodeURIComponent(id)}/plan`,
      json(body),
    ),
  setOverride: (
    id: string,
    capability: string,
    body: { value: EntitlementValue; reason: string; expiresAt?: string | null },
  ) =>
    request(
      ApiOpsCommercialSchema,
      `/ops/organizations/${encodeURIComponent(id)}/overrides/${encodeURIComponent(capability)}`,
      json(body),
    ),
  removeOverride: (id: string, capability: string, reason: string) =>
    request(
      ApiOpsCommercialSchema,
      `/ops/organizations/${encodeURIComponent(id)}/overrides/${encodeURIComponent(capability)}/remove`,
      json({ reason }),
    ),
  plans: () => request(z.array(ApiOpsPlanSchema), '/ops/plans'),
  setPlanEntitlement: (key: string, capability: string, value: EntitlementValue, reason: string) =>
    request(
      z.array(ApiOpsPlanSchema),
      `/ops/plans/${encodeURIComponent(key)}/entitlements/${encodeURIComponent(capability)}`,
      { ...json({ value, reason }), method: 'PATCH' },
    ),
  events: (organizationId?: string) =>
    request(
      z.array(ApiCommercialEventSchema),
      `/ops/commercial/events${organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ''}`,
    ),
  erp: () => request(Loose, '/ops/erp'),
  processing: () => request(Loose, '/ops/processing'),
  system: () => request(Loose, '/ops/system'),
  security: () => request(z.array(Loose), '/ops/security'),
  settings: () => request(Loose, '/ops/settings'),
};
