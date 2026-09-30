import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiCommercialEventSchema,
  ApiOpsCommercialSchema,
  ApiOpsOrganizationSchema,
  ApiOpsPlanSchema,
  CAPABILITIES,
  COMMERCIAL_STATUSES,
  EntitlementValueSchema,
} from '@veyra/shared';
import { CAPABILITY_LABEL, ERP_CAPABILITIES, describeConnection } from '@veyra/erp-connector';
import type { CommercialAdmin } from '../commercial/admin';
import { ENTITLEMENT_CACHE_MS } from '../commercial/entitlements';
import * as t from '../db/schema';
import type { Users } from '../auth/users';
import type { Environment } from '../config';
import type { Veyra } from '../workflow/veyra';
import type { ReadinessReport } from './health';

/**
 * Veyra Operations, the control plane (Phase 8A, docs/OPERATIONS.md): `/api/v1/ops/*`.
 *
 * Every route needs an ops permission, which only VEYRA_ADMIN has (a platform account; a customer
 * ADMIN never does). Reads are `ops.view`; changes are `ops.manage`, go through CommercialAdmin
 * (validated, audited in the same transaction) and require a reason. There is no delete, no SQL,
 * no generic switch: every change is one capability key with a value of its type.
 *
 * Nothing here returns invoice or document contents, secrets or connection details: counts,
 * statuses, codes, and the commercial records themselves.
 */
export interface OpsDeps {
  veyra: Veyra;
  commercial: CommercialAdmin;
  users: Users;
  environment: Environment;
  readiness?: () => Promise<ReadinessReport>;
  send: <S extends z.ZodType>(schema: S, value: z.input<S>) => z.output<S>;
}

const VIEW = { config: { access: 'ops.view' } } as const;
const MANAGE = { config: { access: 'ops.manage' } } as const;
const OrgId = z.object({ id: z.string().min(1).max(64) });
const Reason = z.string().max(500);
const Capability = z.string().max(80);

export function registerOps(app: FastifyInstance, d: OpsDeps): void {
  const { veyra, commercial } = d;
  const ctx = (req: FastifyRequest) => ({
    actorUserId: req.auth?.user.id ?? '',
    requestId: req.id,
  });

  // ── Overview ────────────────────────────────────────────────────────────
  app.get('/api/v1/ops/overview', VIEW, async () => {
    const now = veyra.clock();
    const soon = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    const [organizations, activeOverrides, expiring, readiness] = await Promise.all([
      commercial.organizations(),
      veyra.db
        .select({ n: sql<number>`count(*)::int` })
        .from(t.entitlementOverrides)
        .where(
          and(
            isNull(t.entitlementOverrides.revokedAt),
            sql`(${t.entitlementOverrides.expiresAt} IS NULL OR ${t.entitlementOverrides.expiresAt} > ${now.toISOString()}::timestamptz)`,
          ),
        ),
      veyra.db
        .select({ n: sql<number>`count(*)::int` })
        .from(t.entitlementOverrides)
        .where(
          and(
            isNull(t.entitlementOverrides.revokedAt),
            sql`${t.entitlementOverrides.expiresAt} > ${now.toISOString()}::timestamptz`,
            sql`${t.entitlementOverrides.expiresAt} <= ${soon}::timestamptz`,
          ),
        ),
      d.readiness ? d.readiness() : Promise.resolve(null),
    ]);
    // Usage against limits, per organization (one per deployment today: a handful of queries).
    const near: { organizationId: string; capability: string; used: number; limit: number }[] = [];
    for (const o of organizations) {
      const c = await commercial.commercial(o.id);
      for (const e of c.entitlements)
        if ('limit' in e.effective && e.effective.limit !== null && e.used !== null)
          if (e.used >= e.effective.limit * 0.8)
            near.push({
              organizationId: o.id,
              capability: e.capability,
              used: e.used,
              limit: e.effective.limit,
            });
    }
    const byPlan: Record<string, number> = {};
    for (const o of organizations) {
      const key = o.plan?.key ?? 'none';
      byPlan[key] = (byPlan[key] ?? 0) + 1;
    }
    return {
      organizations: organizations.length,
      byPlan,
      trial: organizations.filter((o) => o.commercialStatus === 'trial').length,
      activeOverrides: activeOverrides[0]?.n ?? 0,
      expiringWithin30Days: expiring[0]?.n ?? 0,
      nearOrOverLimit: near,
      billing: 'not_configured',
      health: readiness
        ? {
            status: readiness.status,
            checks: readiness.checks,
            jobs: readiness.jobs,
            pool: readiness.pool,
          }
        : null,
      environment: d.environment,
    };
  });

  // ── Organizations and commercial state ──────────────────────────────────
  app.get('/api/v1/ops/organizations', VIEW, async () =>
    d.send(z.array(ApiOpsOrganizationSchema), await commercial.organizations()),
  );
  app.get('/api/v1/ops/organizations/:id/commercial', VIEW, async (req) =>
    d.send(ApiOpsCommercialSchema, await commercial.commercial(OrgId.parse(req.params).id)),
  );
  app.post('/api/v1/ops/organizations/:id/plan', MANAGE, async (req) => {
    const { id } = OrgId.parse(req.params);
    const body = z
      .object({
        planKey: z.string().max(40),
        reason: Reason,
        commercialStatus: z.enum(COMMERCIAL_STATUSES).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    await commercial.assignPlan(id, body, ctx(req));
    return d.send(ApiOpsCommercialSchema, await commercial.commercial(id));
  });
  app.post('/api/v1/ops/organizations/:id/overrides/:capability', MANAGE, async (req) => {
    const { id, capability } = OrgId.extend({ capability: Capability }).parse(req.params);
    const body = z
      .object({
        value: EntitlementValueSchema,
        reason: Reason,
        expiresAt: z.string().max(40).nullable().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    await commercial.setOverride(id, capability, body, ctx(req));
    return d.send(ApiOpsCommercialSchema, await commercial.commercial(id));
  });
  app.post('/api/v1/ops/organizations/:id/overrides/:capability/remove', MANAGE, async (req) => {
    const { id, capability } = OrgId.extend({ capability: Capability }).parse(req.params);
    const body = z
      .object({ reason: Reason })
      .strict()
      .parse(req.body ?? {});
    await commercial.removeOverride(id, capability, body, ctx(req));
    return d.send(ApiOpsCommercialSchema, await commercial.commercial(id));
  });

  // ── Plans and the capability catalogue ──────────────────────────────────
  app.get('/api/v1/ops/plans', VIEW, async () =>
    d.send(z.array(ApiOpsPlanSchema), await commercial.plans()),
  );
  app.patch('/api/v1/ops/plans/:key/entitlements/:capability', MANAGE, async (req) => {
    const { key, capability } = z
      .object({ key: z.string().max(40), capability: Capability })
      .parse(req.params);
    const body = z
      .object({ value: EntitlementValueSchema, reason: Reason })
      .strict()
      .parse(req.body ?? {});
    await commercial.setPlanEntitlement(key, capability, body, ctx(req));
    return d.send(z.array(ApiOpsPlanSchema), await commercial.plans());
  });
  app.get('/api/v1/ops/capabilities', VIEW, async () => CAPABILITIES);

  // ── The commercial audit trail ──────────────────────────────────────────
  app.get('/api/v1/ops/commercial/events', VIEW, async (req) => {
    const q = z.object({ organizationId: z.string().max(64).optional() }).parse(req.query ?? {});
    return d.send(
      z.array(ApiCommercialEventSchema),
      await commercial.events(q.organizationId ? { organizationId: q.organizationId } : {}),
    );
  });

  // ── Platform: ERP connection, processing, exceptions, health, security ──
  app.get('/api/v1/ops/erp', VIEW, async () => {
    const c = await describeConnection(veyra.erp);
    return {
      type: c.type,
      displayName: c.displayName,
      version: c.version,
      status: c.status,
      connections: 1,
      capabilities: ERP_CAPABILITIES.map((key) => ({
        key,
        label: CAPABILITY_LABEL[key],
        supported: c.capabilities.includes(key),
      })),
    };
  });
  app.get('/api/v1/ops/processing', VIEW, async () => {
    const [jobs, recentFailures] = await Promise.all([
      veyra.db
        .select({ status: t.jobs.status, n: sql<number>`count(*)::int` })
        .from(t.jobs)
        .groupBy(t.jobs.status),
      // Exceptions: invoices that failed, by stage (ids, stage and time only; no contents).
      veyra.db
        .select({
          id: t.invoices.id,
          stage: t.invoices.failedStage,
          updatedAt: t.invoices.updatedAt,
        })
        .from(t.invoices)
        .where(eq(t.invoices.state, 'FAILED'))
        .orderBy(desc(t.invoices.updatedAt))
        .limit(50),
    ]);
    const usage = (await commercial.commercial(veyra.organizationId)).usage;
    return {
      jobs: Object.fromEntries(jobs.map((j) => [j.status, j.n])),
      invoices: usage.invoicesByOutcome,
      ocrThisMonth: usage.ocrThisMonth,
      erpWritesThisMonth: usage.erpWritesThisMonth,
      failed: recentFailures,
    };
  });
  app.get('/api/v1/ops/system', VIEW, async () =>
    d.readiness ? d.readiness() : { status: 'ready', environment: d.environment },
  );
  app.get('/api/v1/ops/security', VIEW, async () =>
    (await d.users.events(200)).map(({ e }) => ({
      id: e.id,
      at: e.createdAt,
      event: e.event,
      userId: e.userId,
      requestId: e.requestId,
    })),
  );
  app.get('/api/v1/ops/settings', VIEW, async () => ({
    environment: d.environment,
    billing: 'not_configured',
    entitlementCacheSeconds: ENTITLEMENT_CACHE_MS / 1000,
    organizationsPerDeployment: 1,
  }));
}
