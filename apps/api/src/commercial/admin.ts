import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  CAPABILITIES,
  capabilityDefinition,
  COMMERCIAL_STATUSES,
  type ApiCommercialEvent,
  type ApiOpsCommercial,
  type ApiOpsEntitlement,
  type ApiOpsOrganization,
  type ApiOpsPlan,
  type CapabilityDefinition,
  type CapabilityKey,
  type CommercialEvent,
  type CommercialStatus,
  type EntitlementValue,
} from '@veyra/shared';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';
import { ulid } from '../ids';
import { VeyraError } from '../workflow/veyra';
import type { Effective, Entitlements } from './entitlements';
import { usageOf, usedFor } from './usage';

/** Who changes what, on which request (every commercial change is attributed). */
export interface CommercialContext {
  actorUserId: string;
  requestId: string | null;
}

const MAX_REASON = 500;

/**
 * Veyra Operations' commercial actions (Phase 8A): assign a plan, change a plan's entitlement,
 * set or remove an organization override. Each one validates its input, writes the change and its
 * audit event in ONE transaction (never a change without its audit, never an audit without its
 * change), and invalidates the entitlement cache. Nothing is deleted: overrides are revoked, and
 * the audit trail is append-only. There is no generic bypass: a change is always one capability key
 * with a value of that capability's type.
 */
export class CommercialAdmin {
  constructor(
    private readonly db: VeyraDb,
    private readonly entitlements: Entitlements,
    private readonly clock: () => Date,
  ) {}

  private now = () => this.clock().toISOString();

  private reasonOf(reason: string): string {
    const r = reason.trim();
    if (!r) throw new VeyraError('INVALID_INPUT', 'Give a reason for this change.');
    if (r.length > MAX_REASON)
      throw new VeyraError('INVALID_INPUT', `Keep the reason under ${MAX_REASON} characters.`);
    return r;
  }

  private definitionOf(capability: string): CapabilityDefinition {
    const def = capabilityDefinition(capability);
    if (!def) throw new VeyraError('INVALID_INPUT', 'There is no such capability.');
    return def;
  }

  /** A value must have the capability's type: on/off for BOOLEAN, a quota for LIMIT. */
  private valueOf(def: CapabilityDefinition, value: EntitlementValue): EntitlementValue {
    if (def.type === 'BOOLEAN') {
      if (!('enabled' in value))
        throw new VeyraError('INVALID_INPUT', `${def.name} is switched on or off.`);
      return { enabled: value.enabled };
    }
    if (!('limit' in value)) throw new VeyraError('INVALID_INPUT', `${def.name} is a limit.`);
    if (value.limit !== null && (!Number.isSafeInteger(value.limit) || value.limit < 0))
      throw new VeyraError('INVALID_INPUT', 'A limit is a whole number, 0 or more.');
    return { limit: value.limit };
  }

  private async customerOrganization(id: string) {
    const org = (
      await this.db.select().from(t.organizations).where(eq(t.organizations.id, id)).limit(1)
    )[0];
    if (!org || org.id === t.PLATFORM_ORGANIZATION_ID)
      throw new VeyraError('NOT_FOUND', 'Organization not found.');
    return org;
  }

  private async event(
    tx: VeyraDb,
    event: CommercialEvent,
    e: {
      organizationId?: string | null;
      planKey?: string | null;
      capability?: string | null;
      oldValue: unknown;
      newValue: unknown;
      reason: string;
      expiresAt?: string | null;
    },
    ctx: CommercialContext,
  ): Promise<void> {
    await tx.insert(t.commercialEvents).values({
      id: ulid(),
      event,
      organizationId: e.organizationId ?? null,
      planKey: e.planKey ?? null,
      capability: e.capability ?? null,
      oldValueJson: e.oldValue === undefined ? null : JSON.stringify(e.oldValue),
      newValueJson: e.newValue === undefined ? null : JSON.stringify(e.newValue),
      reason: e.reason,
      expiresAt: e.expiresAt ?? null,
      actorUserId: ctx.actorUserId,
      requestId: ctx.requestId,
      createdAt: this.now(),
    });
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  async organizations(): Promise<ApiOpsOrganization[]> {
    const rows = await this.db
      .select({ o: t.organizations, planName: t.plans.name })
      .from(t.organizations)
      .leftJoin(t.plans, eq(t.plans.key, t.organizations.planKey))
      .where(sql`${t.organizations.id} <> ${t.PLATFORM_ORGANIZATION_ID}`)
      .orderBy(asc(t.organizations.name));
    return rows.map(({ o, planName }) => ({
      id: o.id,
      name: o.name,
      commercialStatus: o.commercialStatus as CommercialStatus,
      plan: o.planKey ? { key: o.planKey, name: planName ?? o.planKey } : null,
      planAssignedAt: o.planAssignedAt,
      createdAt: o.createdAt,
      billing: 'not_configured' as const,
    }));
  }

  private entitlementDto(e: Effective, used: number | null): ApiOpsEntitlement {
    return {
      capability: e.capability,
      name: e.definition.name,
      description: e.definition.description,
      category: e.definition.category,
      type: e.definition.type,
      unit: e.definition.unit ?? null,
      plan: e.plan,
      override: e.override
        ? {
            value: e.override.value,
            reason: e.override.row.reason,
            expiresAt: e.override.row.expiresAt,
            expired: e.override.expired,
            setBy: e.override.row.createdByUserId,
            setAt: e.override.row.createdAt,
          }
        : null,
      effective: e.effective,
      source: e.source,
      used,
    };
  }

  /** Plan, plan default, override, effective value and usage, per capability: the "why". */
  async commercial(organizationId: string): Promise<ApiOpsCommercial> {
    await this.customerOrganization(organizationId);
    const [organization, effective, usage] = await Promise.all([
      this.organizations().then((all) => all.find((o) => o.id === organizationId)),
      this.entitlements.all(organizationId),
      usageOf(this.db, organizationId, this.clock()),
    ]);
    if (!organization) throw new VeyraError('NOT_FOUND', 'Organization not found.');
    return {
      organization,
      entitlements: effective.map((e) =>
        this.entitlementDto(e, e.definition.type === 'LIMIT' ? usedFor(e.capability, usage) : null),
      ),
      usage,
    };
  }

  async plans(): Promise<ApiOpsPlan[]> {
    const [plans, rows, counts] = await Promise.all([
      this.db.select().from(t.plans).orderBy(asc(t.plans.createdAt), asc(t.plans.key)),
      this.db.select().from(t.planEntitlements),
      this.db
        .select({ planKey: t.organizations.planKey, n: sql<number>`count(*)::int` })
        .from(t.organizations)
        .groupBy(t.organizations.planKey),
    ]);
    return plans.map((p) => ({
      key: p.key,
      name: p.name,
      status: p.status as ApiOpsPlan['status'],
      description: p.description,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      organizations: counts.find((c) => c.planKey === p.key)?.n ?? 0,
      entitlements: (CAPABILITIES as readonly CapabilityDefinition[]).map((def) => {
        const row = rows.find((r) => r.planKey === p.key && r.capability === def.key);
        return {
          capability: def.key as CapabilityKey,
          value: row
            ? def.type === 'BOOLEAN'
              ? { enabled: row.enabled === true }
              : { limit: row.limitValue === null ? null : Number(row.limitValue) }
            : null,
        };
      }),
    }));
  }

  async events(
    opts: { organizationId?: string; limit?: number } = {},
  ): Promise<ApiCommercialEvent[]> {
    const rows = await this.db
      .select({ e: t.commercialEvents, actor: t.users.name })
      .from(t.commercialEvents)
      .leftJoin(t.users, eq(t.users.id, t.commercialEvents.actorUserId))
      .where(
        opts.organizationId
          ? eq(t.commercialEvents.organizationId, opts.organizationId)
          : undefined,
      )
      .orderBy(desc(t.commercialEvents.seq))
      .limit(Math.min(opts.limit ?? 200, 500));
    return rows.map(({ e, actor }) => ({
      id: e.id,
      at: e.createdAt,
      event: e.event as CommercialEvent,
      organizationId: e.organizationId,
      planKey: e.planKey,
      capability: e.capability,
      oldValue: e.oldValueJson === null ? null : (JSON.parse(e.oldValueJson) as unknown),
      newValue: e.newValueJson === null ? null : (JSON.parse(e.newValueJson) as unknown),
      reason: e.reason,
      expiresAt: e.expiresAt,
      actor,
      requestId: e.requestId,
    }));
  }

  // ── Changing ──────────────────────────────────────────────────────────────

  /** The effective value about to be replaced, read fresh (not from the cache). */
  private async before(organizationId: string, def: CapabilityDefinition): Promise<Effective> {
    this.entitlements.invalidate(organizationId);
    return this.entitlements.get(organizationId, def.key as CapabilityKey);
  }

  /**
   * Inside the change's transaction: one change at a time per organization (row lock), and the
   * override being replaced must still be the one read as "before", so the audit event's old value
   * is exact. Otherwise someone else changed it meanwhile: reload and decide again.
   */
  private async lockUnchanged(
    tx: VeyraDb,
    organizationId: string,
    def: CapabilityDefinition,
    before: Effective,
  ): Promise<void> {
    await tx
      .select({ id: t.organizations.id })
      .from(t.organizations)
      .where(eq(t.organizations.id, organizationId))
      .for('update');
    const active = (
      await tx
        .select({ id: t.entitlementOverrides.id })
        .from(t.entitlementOverrides)
        .where(
          and(
            eq(t.entitlementOverrides.organizationId, organizationId),
            eq(t.entitlementOverrides.capability, def.key),
            isNull(t.entitlementOverrides.revokedAt),
          ),
        )
    )[0];
    if ((active?.id ?? null) !== (before.override?.row.id ?? null))
      throw new VeyraError('CONFLICT', 'This was changed by someone else. Reload and try again.');
  }

  /** Assigns (or changes) an organization's plan, and optionally its commercial status. */
  async assignPlan(
    organizationId: string,
    input: { planKey: string; reason: string; commercialStatus?: CommercialStatus | undefined },
    ctx: CommercialContext,
  ): Promise<void> {
    const reason = this.reasonOf(input.reason);
    if (input.commercialStatus && !COMMERCIAL_STATUSES.includes(input.commercialStatus))
      throw new VeyraError('INVALID_INPUT', 'Choose trial or active.');
    await this.customerOrganization(organizationId);
    await this.db.transaction(async (tx) => {
      const org = (
        await tx
          .select()
          .from(t.organizations)
          .where(eq(t.organizations.id, organizationId))
          .for('update')
      )[0];
      if (!org) throw new VeyraError('NOT_FOUND', 'Organization not found.');
      const plan = (
        await tx.select().from(t.plans).where(eq(t.plans.key, input.planKey)).limit(1)
      )[0];
      if (!plan || plan.status !== 'active')
        throw new VeyraError('INVALID_INPUT', 'Choose an active plan.');
      const status = input.commercialStatus ?? (org.commercialStatus as CommercialStatus);
      if (org.planKey === plan.key && org.commercialStatus === status)
        throw new VeyraError('INVALID_STATE', 'The organization is already on this plan.');
      await tx
        .update(t.organizations)
        .set({ planKey: plan.key, planAssignedAt: this.now(), commercialStatus: status })
        .where(eq(t.organizations.id, organizationId));
      await this.event(
        tx as unknown as VeyraDb,
        'plan.assigned',
        {
          organizationId,
          planKey: plan.key,
          oldValue: { plan: org.planKey, status: org.commercialStatus },
          newValue: { plan: plan.key, status },
          reason,
        },
        ctx,
      );
    });
    this.entitlements.invalidate(organizationId);
  }

  /**
   * Changes what a PLAN includes, for every organization on it. A customer-specific change is an
   * override instead (setOverride), never an edit of the plan.
   */
  async setPlanEntitlement(
    planKey: string,
    capability: string,
    input: { value: EntitlementValue; reason: string },
    ctx: CommercialContext,
  ): Promise<void> {
    const def = this.definitionOf(capability);
    const value = this.valueOf(def, input.value);
    const reason = this.reasonOf(input.reason);
    await this.db.transaction(async (tx) => {
      const plan = (
        await tx.select().from(t.plans).where(eq(t.plans.key, planKey)).for('update')
      )[0];
      if (!plan) throw new VeyraError('NOT_FOUND', 'Plan not found.');
      const row = (
        await tx
          .select()
          .from(t.planEntitlements)
          .where(
            and(
              eq(t.planEntitlements.planKey, planKey),
              eq(t.planEntitlements.capability, def.key),
            ),
          )
      )[0];
      const old: EntitlementValue | null = row
        ? def.type === 'BOOLEAN'
          ? { enabled: row.enabled === true }
          : { limit: row.limitValue === null ? null : Number(row.limitValue) }
        : null;
      const now = this.now();
      const columns =
        'enabled' in value
          ? { enabled: value.enabled, limitValue: null }
          : { enabled: null, limitValue: value.limit };
      await tx
        .insert(t.planEntitlements)
        .values({ planKey, capability: def.key, ...columns, updatedAt: now })
        .onConflictDoUpdate({
          target: [t.planEntitlements.planKey, t.planEntitlements.capability],
          set: { ...columns, updatedAt: now },
        });
      await tx.update(t.plans).set({ updatedAt: now }).where(eq(t.plans.key, planKey));
      await this.event(
        tx as unknown as VeyraDb,
        'plan.entitlement_changed',
        { planKey, capability: def.key, oldValue: old, newValue: value, reason },
        ctx,
      );
    });
    this.entitlements.invalidate();
  }

  /**
   * Sets an organization override: the new value replaces any active override (which is revoked,
   * not edited), with the effective value before the change recorded in the audit event. An expiry
   * makes it temporary.
   */
  async setOverride(
    organizationId: string,
    capability: string,
    input: { value: EntitlementValue; reason: string; expiresAt?: string | null | undefined },
    ctx: CommercialContext,
  ): Promise<void> {
    const def = this.definitionOf(capability);
    const value = this.valueOf(def, input.value);
    const reason = this.reasonOf(input.reason);
    let expiresAt: string | null = null;
    if (input.expiresAt) {
      const at = Date.parse(input.expiresAt);
      if (Number.isNaN(at)) throw new VeyraError('INVALID_INPUT', 'Give a valid expiry date.');
      if (at <= this.clock().getTime())
        throw new VeyraError('INVALID_INPUT', 'The expiry must be in the future.');
      expiresAt = new Date(at).toISOString();
    }
    await this.customerOrganization(organizationId);
    const before = await this.before(organizationId, def);
    await this.db.transaction(async (tx) => {
      await this.lockUnchanged(tx as unknown as VeyraDb, organizationId, def, before);
      const now = this.now();
      await tx
        .update(t.entitlementOverrides)
        .set({ revokedAt: now, revokedByUserId: ctx.actorUserId })
        .where(
          and(
            eq(t.entitlementOverrides.organizationId, organizationId),
            eq(t.entitlementOverrides.capability, def.key),
            isNull(t.entitlementOverrides.revokedAt),
          ),
        );
      await tx.insert(t.entitlementOverrides).values({
        id: ulid(),
        organizationId,
        capability: def.key,
        enabled: 'enabled' in value ? value.enabled : null,
        limitValue: 'limit' in value ? value.limit : null,
        unlimited: 'limit' in value && value.limit === null,
        reason,
        expiresAt,
        createdByUserId: ctx.actorUserId,
        createdAt: now,
      });
      await this.event(
        tx as unknown as VeyraDb,
        'override.set',
        {
          organizationId,
          capability: def.key,
          oldValue: before.effective,
          newValue: value,
          reason,
          expiresAt,
        },
        ctx,
      );
    });
    this.entitlements.invalidate(organizationId);
  }

  /** Removes (revokes) the organization's override: the plan applies again. */
  async removeOverride(
    organizationId: string,
    capability: string,
    input: { reason: string },
    ctx: CommercialContext,
  ): Promise<void> {
    const def = this.definitionOf(capability);
    const reason = this.reasonOf(input.reason);
    await this.customerOrganization(organizationId);
    const before = await this.before(organizationId, def);
    const active = before.override;
    if (!active) throw new VeyraError('INVALID_STATE', 'There is no override to remove.');
    await this.db.transaction(async (tx) => {
      await this.lockUnchanged(tx as unknown as VeyraDb, organizationId, def, before);
      await tx
        .update(t.entitlementOverrides)
        .set({ revokedAt: this.now(), revokedByUserId: ctx.actorUserId })
        .where(eq(t.entitlementOverrides.id, active.row.id));
      await this.event(
        tx as unknown as VeyraDb,
        'override.removed',
        {
          organizationId,
          capability: def.key,
          oldValue: before.effective,
          newValue: before.plan ?? (def.type === 'BOOLEAN' ? { enabled: false } : { limit: 0 }),
          reason,
        },
        ctx,
      );
    });
    this.entitlements.invalidate(organizationId);
  }
}
