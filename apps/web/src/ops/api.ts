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
 * Veyrafy Operations' calls (Phase 8A): `/api/v1/ops/*`, which only a VEYRA_ADMIN session may use.
 * Every change carries a reason; the server validates and audits it.
 */
const Loose = z.record(z.string(), z.unknown());
/** Control Centre reads: shaped by the server (apps/api/src/ops/control-centre.ts), typed here. */
const As = <T>() => z.custom<T>(() => true);
const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  return s ? `?${s}` : '';
};
const C = '/ops/centre';

export type Paise = number | null;
export interface Alert {
  level: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  section: string;
}
export interface CentreOverview {
  customers: number;
  activeCustomers: number;
  users: { customer: number; active: number; platform: number };
  invoicesThisMonth: number;
  processingNow: number;
  needsInput: number;
  failedInvoices: number;
  stuckInvoices: number;
  jobs: { failed: number; queued: number; running: number };
  cost: {
    month: { from: string; to: string };
    aiPaise: Paise;
    totalPaise: Paise;
    perInvoicePaise: Paise;
    invoices: number;
  };
  mrr: { paise: Paise; status: 'ok' | 'price_not_set' | 'no_paying_customers' };
  health: { status: string } | null;
  environment: string;
  alerts: Alert[];
}
export interface Customer {
  id: string;
  name: string;
  status: CommercialStatus;
  plan: { key: string; name: string } | null;
  planAssignedAt: string | null;
  createdAt: string;
  invoiceAllowance: number | null;
  invoicesThisMonth: number;
  invoicesTotal: number;
  usagePercent: number | null;
  users: number;
  activeUsers: number;
  storageBytes: number;
  costThisMonth: { aiPaise: Paise; totalPaise: Paise };
  lastActivityAt: string | null;
}
export interface CentreUser {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  organizationId: string;
  organization: string | null;
  platform: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  lastLoginAt: string | null;
}
export type Phase = 'waiting' | 'running' | 'done' | 'needs_input' | 'failed' | 'rejected' | 'n/a';
export interface ProcessingRow {
  id: string;
  customer: { id: string; name: string };
  state: string;
  uploadedAt: string;
  updatedAt: string;
  processingMs: number | null;
  extraction: Phase;
  verification: Phase;
  resolution: Phase;
  failed: boolean;
  stuck: boolean;
  failedStage: string | null;
  failureReason: string | null;
  retryCount: number;
  failedJobs: number;
  readings: number;
  retryable: boolean;
}
export interface FailureGroup {
  stage: string | null;
  reason: string | null;
  count: number;
  lastAt: string;
}
export interface UsageReading {
  id: string;
  at: string;
  method: string;
  pages: number;
  aiModel: string | null;
  aiCalls: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  durationMs: number | null;
  documentBytes: number;
  aiPaise: Paise;
}
export interface ProcessingDetail {
  summary: ProcessingRow;
  events: {
    at: string;
    event: string;
    fromState: string | null;
    toState: string | null;
    actorType: string;
  }[];
  jobs: {
    id: string;
    type: string;
    status: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
  usage: UsageReading[];
}
export interface Pricing {
  aiInputPer1MPaise: Paise;
  aiOutputPer1MPaise: Paise;
  models: Record<string, { inputPer1MPaise: Paise; outputPer1MPaise: Paise }>;
  infrastructurePerInvoicePaise: Paise;
}
export interface CostBucket {
  key: string;
  name?: string;
  readings: number;
  invoices: number;
  pages: number;
  aiCalls: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiPaise: Paise;
  aiPaisePriced: number;
  unpricedReadings: number;
  infrastructurePaise: Paise;
  totalPaise: Paise;
  perInvoicePaise: Paise;
  avgDurationMs: number | null;
  storageBytes: number;
}
export interface CentreCost {
  month: { from: string; to: string };
  pricing: Pricing;
  totals: CostBucket;
  geminiPaise: Paise;
  documentAi: { pages: number; paise: number; used: boolean };
  geminiUsagePercent: number | null;
  byCustomer: CostBucket[];
  byMethod: CostBucket[];
  byModel: CostBucket[];
  ledger: (UsageReading & { invoiceId: string; customerId: string; totalPaise: Paise })[];
}
export interface CentreConfig {
  environment: string;
  ai: {
    provider: string | null;
    configured: boolean;
    model: string | null;
    backupModels: string[];
    reader: string;
    localOcr: boolean;
    documentAi: boolean;
  };
  confidenceMinBp: number;
  confidenceRange: { min: number; max: number };
  retention: { mode: string; days: number | null };
  email: { configured: boolean; note: string };
  limits: {
    maxUploadBytes: number;
    rateLimitsPerMinute: Record<string, number>;
    stuckAfterMinutes: number;
  };
  autoCreatePo: { enabled: boolean; belowPaise: number };
  health: { status: string; checks?: unknown } | null;
  organizationsPerDeployment: number;
}
export interface CustomerDetail {
  summary: Customer | null;
  commercial: z.infer<typeof ApiOpsCommercialSchema>;
  users: CentreUser[];
  recentInvoices: ProcessingRow[];
  events: z.infer<typeof ApiCommercialEventSchema>[];
}

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

  // ── Owner Control Centre ──────────────────────────────────────────────────
  centreOverview: () => request(As<CentreOverview>(), `${C}/overview`),
  customers: (search?: string) => request(As<Customer[]>(), `${C}/customers${q({ q: search })}`),
  customer: (id: string) =>
    request(As<CustomerDetail>(), `${C}/customers/${encodeURIComponent(id)}`),
  setSuspended: (id: string, suspended: boolean, reason: string) =>
    request(
      As<CustomerDetail>(),
      `${C}/customers/${encodeURIComponent(id)}/suspension`,
      json({ suspended, reason }),
    ),
  users: (f: { q?: string; organizationId?: string; role?: string; active?: string }) =>
    request(As<CentreUser[]>(), `${C}/users${q(f)}`),
  setUserActive: (id: string, active: boolean, reason: string) =>
    request(
      As<{ ok: true }>(),
      `${C}/users/${encodeURIComponent(id)}/active`,
      json({ active, reason }),
    ),
  processingList: (f: { q?: string; state?: string; problem?: string }) =>
    request(
      As<{ invoices: ProcessingRow[]; failures: FailureGroup[] }>(),
      `${C}/processing${q(f)}`,
    ),
  processingDetail: (id: string) =>
    request(As<ProcessingDetail>(), `${C}/processing/${encodeURIComponent(id)}`),
  retry: (id: string, reason: string) =>
    request(
      As<{ from: string; to: string }>(),
      `${C}/processing/${encodeURIComponent(id)}/retry`,
      json({ reason }),
    ),
  cost: (month?: string) => request(As<CentreCost>(), `${C}/cost${q({ month })}`),
  setPricing: (pricing: Pricing, reason: string) =>
    request(As<Pricing>(), `${C}/pricing`, { ...json({ pricing, reason }), method: 'PUT' }),
  setPlanPrice: (key: string, priceMonthlyPaise: number | null, reason: string) =>
    request(z.array(ApiOpsPlanSchema), `${C}/plans/${encodeURIComponent(key)}/price`, {
      ...json({ priceMonthlyPaise, reason }),
      method: 'PATCH',
    }),
  config: () => request(As<CentreConfig>(), `${C}/config`),
  setConfidence: (confidenceMinBp: number, reason: string) =>
    request(As<CentreConfig>(), `${C}/config/confidence`, {
      ...json({ confidenceMinBp, reason }),
      method: 'PATCH',
    }),
  audit: (f: { q?: string; organizationId?: string; event?: string }) =>
    request(z.array(ApiCommercialEventSchema), `${C}/audit${q(f)}`),
};
