import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { CommercialStatus } from '@veyra/shared';
import type { CommercialAdmin, CommercialContext } from '../commercial/admin';
import { monthOf, usageOf } from '../commercial/usage';
import type { Users } from '../auth/users';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';
import { VeyraError, type Veyra } from '../workflow/veyra';

/**
 * The Veyrafy Owner Control Centre (platform management, VEYRA_ADMIN only): one read model over the
 * product's own records, plus the few owner actions there are. Nothing new is counted twice: the
 * customers, users, invoices and jobs are the product's own rows; the only additions are the
 * per-reading usage ledger (`processing_usage`), the provider rates (one settings row) and the
 * platform audit trail (`commercial_events`).
 *
 * Nothing here returns document contents, extracted values, passwords, tokens or keys. Costs are
 * estimates from the rates the owner sets; no rate is assumed.
 *
 * One customer organization per deployment: this database's invoices and documents belong to
 * `veyra.organizationId`.
 */

/** Settings key of the provider rates (the owner's estimate; never shown to customers). */
export const PRICING_KEY = 'platform.pricing';

const Paise = z.number().int().min(0).max(1_000_000_000_000).nullable();
export const PricingSchema = z
  .object({
    /** Gemini, per million tokens, in paise. Null: not set (cost shown as "rate not set"). */
    aiInputPer1MPaise: Paise,
    aiOutputPer1MPaise: Paise,
    /** Per model, when a backup model is priced differently. */
    models: z
      .record(
        z.string().min(1).max(100),
        z.object({ inputPer1MPaise: Paise, outputPer1MPaise: Paise }).strict(),
      )
      .default({}),
    /** Hosting, storage and OCR compute, averaged per processed invoice. */
    infrastructurePerInvoicePaise: Paise,
  })
  .strict();
export type Pricing = z.infer<typeof PricingSchema>;
export const NO_PRICING: Pricing = {
  aiInputPer1MPaise: null,
  aiOutputPer1MPaise: null,
  models: {},
  infrastructurePerInvoicePaise: null,
};

/** The extraction confidence below which a value is asked about (basis points). */
export const CONFIDENCE_RANGE = { min: 7000, max: 9900 } as const;
const CONFIDENCE_KEY = 'extraction_confidence_min_bp';

const WORKING = ['UPLOADED', 'EXTRACTING', 'MATCHING', 'RESOLVING', 'VALIDATING', 'COMMITTING'];
/** An invoice in a working state that has not moved for this long is reported as stuck. */
export const STUCK_AFTER_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

type UsageRow = typeof t.processingUsage.$inferSelect;

export interface ControlCentreDeps {
  veyra: Veyra;
  commercial: CommercialAdmin;
  users: Users;
  environment: string;
  aiModels: readonly string[];
  limits: { maxUploadBytes: number; rateLimitsPerMinute: Record<string, number> };
  readiness?: () => Promise<{ status: string; checks: unknown; jobs?: unknown }>;
  /** After a suspension or reactivation (the access check caches the status briefly). */
  suspensionChanged?: () => void;
}

/** Cost of one reading. AI null: tokens were used but no rate is set for them. */
export function costOf(
  u: Pick<UsageRow, 'aiModel' | 'aiCalls' | 'aiInputTokens' | 'aiOutputTokens'>,
  p: Pricing,
): { aiPaise: number | null } {
  if (u.aiCalls === 0 && u.aiInputTokens === 0 && u.aiOutputTokens === 0) return { aiPaise: 0 };
  const m = u.aiModel ? p.models[u.aiModel] : undefined;
  const inRate = m?.inputPer1MPaise ?? p.aiInputPer1MPaise;
  const outRate = m?.outputPer1MPaise ?? p.aiOutputPer1MPaise;
  if ((u.aiInputTokens > 0 && inRate === null) || (u.aiOutputTokens > 0 && outRate === null))
    return { aiPaise: null };
  return {
    aiPaise: Math.round(
      (u.aiInputTokens * (inRate ?? 0) + u.aiOutputTokens * (outRate ?? 0)) / 1_000_000,
    ),
  };
}

const n = (v: unknown): number => Number(v ?? 0);

export class ControlCentre {
  constructor(private readonly d: ControlCentreDeps) {}

  private get db(): VeyraDb {
    return this.d.veyra.db;
  }
  private now(): Date {
    return this.d.veyra.clock();
  }

  private reasonOf(reason: string): string {
    const r = reason.trim();
    if (!r) throw new VeyraError('INVALID_INPUT', 'Give a reason for this change.');
    if (r.length > 500)
      throw new VeyraError('INVALID_INPUT', 'Keep the reason under 500 characters.');
    return r;
  }

  // ── Provider rates ───────────────────────────────────────────────────────

  async pricing(db: VeyraDb = this.db): Promise<Pricing> {
    const row = (
      await db.select().from(t.settings).where(eq(t.settings.key, PRICING_KEY)).limit(1)
    )[0];
    if (!row) return NO_PRICING;
    const parsed = PricingSchema.safeParse(JSON.parse(row.valueJson));
    return parsed.success ? parsed.data : NO_PRICING;
  }

  async setPricing(input: unknown, reason: string, ctx: CommercialContext): Promise<Pricing> {
    const next = PricingSchema.parse(input);
    const why = this.reasonOf(reason);
    await this.db.transaction(async (tx) => {
      const db = tx as unknown as VeyraDb;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${PRICING_KEY}))`);
      const before = await this.pricing(db);
      await this.writeSetting(db, PRICING_KEY, next, ctx.actorUserId);
      await this.d.commercial.event(
        db,
        'config.changed',
        { subject: `setting:${PRICING_KEY}`, oldValue: before, newValue: next, reason: why },
        ctx,
      );
    });
    return next;
  }

  private async writeSetting(
    db: VeyraDb,
    key: string,
    value: unknown,
    userId: string,
  ): Promise<void> {
    const valueJson = JSON.stringify(value);
    const updatedAt = this.now().toISOString();
    await db
      .insert(t.settings)
      .values({ key, valueJson, updatedByUserId: userId || null, updatedAt })
      .onConflictDoUpdate({
        target: t.settings.key,
        set: { valueJson, updatedByUserId: userId || null, updatedAt },
      });
  }

  // ── Overview ─────────────────────────────────────────────────────────────

  async overview() {
    const now = this.now();
    const month = monthOf(now);
    const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();
    const [orgs, plans, users, invoices, jobs, cost, readiness, pricing, activity] =
      await Promise.all([
        this.d.commercial.organizations(),
        this.d.commercial.plans(),
        this.db
          .select({
            customer: sql<number>`count(*) filter (where ${t.users.organizationId} <> ${t.PLATFORM_ORGANIZATION_ID})::int`,
            active: sql<number>`count(*) filter (where ${t.users.organizationId} <> ${t.PLATFORM_ORGANIZATION_ID} and ${t.users.active})::int`,
            platform: sql<number>`count(*) filter (where ${t.users.organizationId} = ${t.PLATFORM_ORGANIZATION_ID})::int`,
          })
          .from(t.users),
        this.db
          .select({
            month: sql<number>`count(*) filter (where ${t.invoices.createdAt} >= ${month.from}::timestamptz)::int`,
            processing: sql<number>`count(*) filter (where ${inArray(t.invoices.state, WORKING)})::int`,
            stuck: sql<number>`count(*) filter (where ${inArray(t.invoices.state, WORKING)} and ${t.invoices.updatedAt} < ${stuckBefore}::timestamptz)::int`,
            failed: sql<number>`count(*) filter (where ${t.invoices.state} = 'FAILED')::int`,
            needsInput: sql<number>`count(*) filter (where ${t.invoices.state} = 'NEEDS_INPUT')::int`,
          })
          .from(t.invoices),
        this.db
          .select({
            failed: sql<number>`count(*) filter (where ${t.jobs.status} = 'failed')::int`,
            queued: sql<number>`count(*) filter (where ${t.jobs.status} = 'queued')::int`,
            running: sql<number>`count(*) filter (where ${t.jobs.status} = 'running')::int`,
          })
          .from(t.jobs),
        this.cost(now),
        this.d.readiness ? this.d.readiness().catch(() => null) : Promise.resolve(null),
        this.pricing(),
        this.lastUpload(),
      ]);
    const u = users[0];
    const inv = invoices[0];
    const j = jobs[0];
    const recent = activity !== null && now.getTime() - Date.parse(activity) < 30 * DAY_MS;
    const activeCustomers = orgs.filter(
      (o) => o.commercialStatus !== 'suspended' && o.id === this.d.veyra.organizationId && recent,
    ).length;
    // MRR: the plan price of every paying (active) customer. Not configured when a price is missing.
    const paying = orgs.filter((o) => o.commercialStatus === 'active' && o.plan);
    const prices = paying.map((o) => plans.find((p) => p.key === o.plan?.key)?.priceMonthlyPaise);
    const mrr =
      paying.length === 0
        ? { paise: 0, status: 'no_paying_customers' as const }
        : prices.every((p) => typeof p === 'number')
          ? { paise: prices.reduce<number>((s, p) => s + (p ?? 0), 0), status: 'ok' as const }
          : { paise: null, status: 'price_not_set' as const };

    const alerts: {
      level: 'critical' | 'warning' | 'info';
      title: string;
      detail: string;
      section: string;
    }[] = [];
    if (readiness && readiness.status !== 'ready')
      alerts.push({
        level: 'critical',
        title: 'Service not ready',
        detail: `Health check reports "${readiness.status}".`,
        section: 'config',
      });
    if (n(inv?.stuck) > 0)
      alerts.push({
        level: 'critical',
        title: `${n(inv?.stuck)} invoice${n(inv?.stuck) === 1 ? '' : 's'} stuck`,
        detail: 'In processing with no progress for over 15 minutes.',
        section: 'processing',
      });
    if (n(inv?.failed) > 0)
      alerts.push({
        level: 'warning',
        title: `${n(inv?.failed)} failed invoice${n(inv?.failed) === 1 ? '' : 's'}`,
        detail: 'Could not be processed. Review and retry where safe.',
        section: 'processing',
      });
    if (n(j?.failed) > 0)
      alerts.push({
        level: 'warning',
        title: `${n(j?.failed)} failed background job${n(j?.failed) === 1 ? '' : 's'}`,
        detail: 'A job used up its attempts.',
        section: 'processing',
      });
    for (const o of orgs.filter((x) => x.commercialStatus === 'suspended'))
      alerts.push({
        level: 'info',
        title: `${o.name} is suspended`,
        detail: 'Its users cannot use Veyrafy until it is reactivated.',
        section: 'customers',
      });
    for (const o of orgs) {
      if (o.id !== this.d.veyra.organizationId) continue;
      const c = await this.d.commercial.commercial(o.id);
      for (const e of c.entitlements)
        if ('limit' in e.effective && e.effective.limit !== null && e.used !== null)
          if (e.used >= e.effective.limit * 0.8)
            alerts.push({
              level: e.used >= e.effective.limit ? 'warning' : 'info',
              title: `${o.name}: ${e.name} at ${Math.round((e.used / Math.max(e.effective.limit, 1)) * 100)}%`,
              detail: `${e.used} of ${e.effective.limit} used.`,
              section: 'customers',
            });
    }
    if (pricing.aiInputPer1MPaise === null || pricing.aiOutputPer1MPaise === null)
      alerts.push({
        level: 'info',
        title: 'AI rates not set',
        detail: 'Set provider rates to see estimated AI cost.',
        section: 'cost',
      });
    if (mrr.status === 'price_not_set')
      alerts.push({
        level: 'info',
        title: 'Plan price not set',
        detail: 'Monthly recurring revenue needs a price on every assigned plan.',
        section: 'plans',
      });

    return {
      customers: orgs.length,
      activeCustomers,
      users: { customer: n(u?.customer), active: n(u?.active), platform: n(u?.platform) },
      invoicesThisMonth: n(inv?.month),
      processingNow: n(inv?.processing),
      needsInput: n(inv?.needsInput),
      failedInvoices: n(inv?.failed),
      stuckInvoices: n(inv?.stuck),
      jobs: { failed: n(j?.failed), queued: n(j?.queued), running: n(j?.running) },
      cost: {
        month: cost.month,
        aiPaise: cost.totals.aiPaise,
        totalPaise: cost.totals.totalPaise,
        perInvoicePaise: cost.totals.perInvoicePaise,
        invoices: cost.totals.invoices,
      },
      mrr,
      health: readiness ? { status: readiness.status } : null,
      environment: this.d.environment,
      alerts,
    };
  }

  private async lastUpload(): Promise<string | null> {
    const row = (
      await this.db
        .select({ at: sql<string | null>`max(${t.documents.uploadedAt})` })
        .from(t.documents)
    )[0];
    return row?.at ? new Date(row.at).toISOString() : null;
  }

  // ── Customers ────────────────────────────────────────────────────────────

  async customers(q = '') {
    const now = this.now();
    const [orgs, users, cost, lastUpload, lastSeen] = await Promise.all([
      this.d.commercial.organizations(),
      this.db
        .select({
          org: t.users.organizationId,
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) filter (where ${t.users.active})::int`,
        })
        .from(t.users)
        .groupBy(t.users.organizationId),
      this.cost(now),
      this.lastUpload(),
      this.db
        .select({
          org: t.users.organizationId,
          at: sql<string | null>`max(${t.sessions.lastSeenAt})`,
        })
        .from(t.sessions)
        .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
        .groupBy(t.users.organizationId),
    ]);
    const needle = q.trim().toLowerCase();
    const out = [];
    for (const o of orgs) {
      if (needle && !`${o.name} ${o.id}`.toLowerCase().includes(needle)) continue;
      const own = o.id === this.d.veyra.organizationId;
      const c = await this.d.commercial.commercial(o.id);
      const allowance = c.entitlements.find((e) => e.capability === 'invoice.monthly_limit');
      const limit = allowance && 'limit' in allowance.effective ? allowance.effective.limit : null;
      const used = own ? c.usage.invoicesThisMonth : 0;
      const u = users.find((x) => x.org === o.id);
      const seen = lastSeen.find((x) => x.org === o.id)?.at ?? null;
      const times = [own ? lastUpload : null, seen ? new Date(seen).toISOString() : null].filter(
        (x): x is string => x !== null,
      );
      out.push({
        id: o.id,
        name: o.name,
        status: o.commercialStatus as CommercialStatus,
        plan: o.plan,
        planAssignedAt: o.planAssignedAt,
        createdAt: o.createdAt,
        invoiceAllowance: limit,
        invoicesThisMonth: used,
        invoicesTotal: own ? c.usage.invoicesTotal : 0,
        usagePercent: limit ? Math.round((used / limit) * 100) : null,
        users: n(u?.total),
        activeUsers: n(u?.active),
        storageBytes: own ? c.usage.storageBytes : 0,
        costThisMonth: own
          ? { aiPaise: cost.totals.aiPaise, totalPaise: cost.totals.totalPaise }
          : { aiPaise: 0, totalPaise: 0 },
        lastActivityAt: times.sort().at(-1) ?? null,
      });
    }
    return out;
  }

  async customer(id: string) {
    const commercial = await this.d.commercial.commercial(id);
    const own = id === this.d.veyra.organizationId;
    const [summary, users, invoices, events] = await Promise.all([
      this.customers().then((all) => all.find((c) => c.id === id) ?? null),
      this.users({ organizationId: id }),
      own ? this.processing({ limit: 20 }) : Promise.resolve([]),
      this.d.commercial.events({ organizationId: id, limit: 50 }),
    ]);
    return { summary, commercial, users, recentInvoices: invoices, events };
  }

  async setSuspended(
    id: string,
    body: { suspended: boolean; reason: string },
    ctx: CommercialContext,
  ): Promise<void> {
    await this.d.commercial.setSuspended(id, body, ctx);
    this.d.suspensionChanged?.();
  }

  // ── Users ────────────────────────────────────────────────────────────────

  async users(f: { q?: string; organizationId?: string; role?: string; active?: boolean } = {}) {
    const where: SQL[] = [];
    if (f.organizationId) where.push(eq(t.users.organizationId, f.organizationId));
    if (f.role) where.push(eq(t.users.role, f.role));
    if (f.active !== undefined) where.push(eq(t.users.active, f.active));
    if (f.q?.trim()) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      const match = or(ilike(t.users.name, like), ilike(t.users.email, like));
      if (match) where.push(match);
    }
    const lastSeen = this.db
      .select({
        userId: t.sessions.userId,
        at: sql<string | null>`max(${t.sessions.lastSeenAt})`.as('at'),
      })
      .from(t.sessions)
      .groupBy(t.sessions.userId)
      .as('seen');
    const lastLogin = this.db
      .select({
        userId: t.securityEvents.userId,
        at: sql<string | null>`max(${t.securityEvents.createdAt})`.as('login_at'),
      })
      .from(t.securityEvents)
      .where(eq(t.securityEvents.event, 'login.succeeded'))
      .groupBy(t.securityEvents.userId)
      .as('login');
    const rows = await this.db
      .select({
        // Explicit columns: the password hash is never read here.
        id: t.users.id,
        name: t.users.name,
        email: t.users.email,
        role: t.users.role,
        active: t.users.active,
        organizationId: t.users.organizationId,
        organization: t.organizations.name,
        createdAt: t.users.createdAt,
        lastSeenAt: lastSeen.at,
        lastLoginAt: lastLogin.at,
      })
      .from(t.users)
      .leftJoin(t.organizations, eq(t.organizations.id, t.users.organizationId))
      .leftJoin(lastSeen, eq(lastSeen.userId, t.users.id))
      .leftJoin(lastLogin, eq(lastLogin.userId, t.users.id))
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(t.users.organizationId), asc(t.users.email))
      .limit(500);
    const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
    return rows.map((r) => ({
      ...r,
      platform: r.organizationId === t.PLATFORM_ORGANIZATION_ID,
      lastSeenAt: iso(r.lastSeenAt),
      lastLoginAt: iso(r.lastLoginAt),
    }));
  }

  /**
   * Enables or disables a customer user. The customer's own rules apply (the last administrator
   * stays, the user quota holds); disabling ends every session of that user at once. Platform
   * accounts are managed from the command line, never from here, and nobody disables themselves.
   */
  async setUserActive(
    id: string,
    body: { active: boolean; reason: string },
    ctx: CommercialContext,
  ): Promise<void> {
    const why = this.reasonOf(body.reason);
    if (id === ctx.actorUserId)
      throw new VeyraError('INVALID_STATE', 'You cannot disable your own account.');
    const user = (
      await this.db
        .select({ id: t.users.id, org: t.users.organizationId, active: t.users.active })
        .from(t.users)
        .where(eq(t.users.id, id))
        .limit(1)
    )[0];
    if (!user) throw new VeyraError('NOT_FOUND', 'User not found.');
    if (user.org !== this.d.users.organizationId)
      throw new VeyraError(
        'INVALID_STATE',
        'Platform accounts are managed from the command line, not from the Control Centre.',
      );
    if (user.active === body.active)
      throw new VeyraError(
        'INVALID_STATE',
        body.active ? 'This user is already enabled.' : 'This user is already disabled.',
      );
    // Validated, session-revoking and security-logged by the users service itself.
    await this.d.users.update(
      id,
      { active: body.active },
      { userId: ctx.actorUserId || null, requestId: ctx.requestId },
    );
    await this.d.commercial.event(
      this.db,
      body.active ? 'user.enabled' : 'user.disabled',
      {
        organizationId: user.org,
        subject: `user:${id}`,
        oldValue: { active: user.active },
        newValue: { active: body.active },
        reason: why,
      },
      ctx,
    );
  }

  // ── Invoice processing ───────────────────────────────────────────────────

  async processing(
    f: { q?: string; state?: string; problem?: 'failed' | 'stuck'; limit?: number } = {},
  ) {
    const now = this.now();
    const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();
    const where: SQL[] = [];
    if (f.state) where.push(eq(t.invoices.state, f.state));
    if (f.problem === 'failed') where.push(eq(t.invoices.state, 'FAILED'));
    if (f.problem === 'stuck') {
      where.push(inArray(t.invoices.state, WORKING));
      where.push(lt(t.invoices.updatedAt, stuckBefore));
    }
    if (f.q?.trim()) where.push(ilike(t.invoices.id, `%${f.q.trim().replace(/[%_\\]/g, '')}%`));
    const rows = await this.db
      .select({
        id: t.invoices.id,
        state: t.invoices.state,
        failedStage: t.invoices.failedStage,
        failureReason: t.invoices.failureReason,
        runNo: t.invoices.runNo,
        createdAt: t.invoices.createdAt,
        updatedAt: t.invoices.updatedAt,
        uploadedAt: t.documents.uploadedAt,
        documentDeleted: sql<boolean>`${t.documents.deletedAt} is not null`,
      })
      .from(t.invoices)
      .innerJoin(t.documents, eq(t.documents.id, t.invoices.documentId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(t.invoices.seq))
      .limit(Math.min(f.limit ?? 200, 500));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [jobs, usage, restarts] = await Promise.all([
      this.db
        .select({
          invoiceId: t.jobs.invoiceId,
          retries: sql<number>`coalesce(sum(greatest(${t.jobs.attempts} - 1, 0)), 0)::int`,
          failed: sql<number>`count(*) filter (where ${t.jobs.status} = 'failed')::int`,
        })
        .from(t.jobs)
        .where(inArray(t.jobs.invoiceId, ids))
        .groupBy(t.jobs.invoiceId),
      this.db
        .select({
          invoiceId: t.processingUsage.invoiceId,
          ms: sql<number | null>`sum(${t.processingUsage.durationMs})::int`,
          readings: sql<number>`count(*)::int`,
        })
        .from(t.processingUsage)
        .where(inArray(t.processingUsage.invoiceId, ids))
        .groupBy(t.processingUsage.invoiceId),
      this.db
        .select({ invoiceId: t.auditEvents.invoiceId, n: sql<number>`count(*)::int` })
        .from(t.auditEvents)
        .where(and(inArray(t.auditEvents.invoiceId, ids), eq(t.auditEvents.fromState, 'FAILED')))
        .groupBy(t.auditEvents.invoiceId),
    ]);
    const org = await this.orgName();
    return rows.map((r) => {
      const j = jobs.find((x) => x.invoiceId === r.id);
      const u = usage.find((x) => x.invoiceId === r.id);
      const stuck = WORKING.includes(r.state) && r.updatedAt < stuckBefore;
      return {
        id: r.id,
        customer: { id: this.d.veyra.organizationId, name: org },
        state: r.state,
        uploadedAt: r.uploadedAt,
        updatedAt: r.updatedAt,
        processingMs: u?.ms ?? null,
        ...stagesOf(r.state, r.failedStage),
        failed: r.state === 'FAILED',
        stuck,
        failedStage: r.failedStage,
        failureReason: r.failureReason ? r.failureReason.slice(0, 200) : null,
        retryCount: n(j?.retries) + n(restarts.find((x) => x.invoiceId === r.id)?.n),
        failedJobs: n(j?.failed),
        readings: n(u?.readings),
        retryable: r.state === 'FAILED' && !r.documentDeleted,
      };
    });
  }

  private async orgName(): Promise<string> {
    const row = (
      await this.db
        .select({ name: t.organizations.name })
        .from(t.organizations)
        .where(eq(t.organizations.id, this.d.veyra.organizationId))
        .limit(1)
    )[0];
    return row?.name ?? this.d.veyra.organizationId;
  }

  /** One invoice's processing history: states, jobs and usage. No values, no document. */
  async processingDetail(id: string) {
    const [summary] = await this.processing({ q: id, limit: 50 }).then((r) =>
      r.filter((x) => x.id === id),
    );
    if (!summary) throw new VeyraError('NOT_FOUND', 'Invoice not found.');
    const [events, jobs, usage, pricing] = await Promise.all([
      this.db
        .select({
          // Never detail_json: it can hold extracted values.
          at: t.auditEvents.createdAt,
          event: t.auditEvents.event,
          fromState: t.auditEvents.fromState,
          toState: t.auditEvents.toState,
          actorType: t.auditEvents.actorType,
        })
        .from(t.auditEvents)
        .where(eq(t.auditEvents.invoiceId, id))
        .orderBy(asc(t.auditEvents.seq))
        .limit(300),
      this.db
        .select({
          id: t.jobs.id,
          type: t.jobs.type,
          status: t.jobs.status,
          attempts: t.jobs.attempts,
          lastError: t.jobs.lastError,
          createdAt: t.jobs.createdAt,
          updatedAt: t.jobs.updatedAt,
        })
        .from(t.jobs)
        .where(eq(t.jobs.invoiceId, id))
        .orderBy(asc(t.jobs.seq)),
      this.db
        .select()
        .from(t.processingUsage)
        .where(eq(t.processingUsage.invoiceId, id))
        .orderBy(asc(t.processingUsage.seq)),
      this.pricing(),
    ]);
    return {
      summary,
      events,
      jobs: jobs.map((j) => ({ ...j, lastError: j.lastError ? j.lastError.slice(0, 200) : null })),
      usage: usage.map((u) => ({ ...this.usageDto(u), ...costOf(u, pricing) })),
    };
  }

  private usageDto(u: UsageRow) {
    return {
      id: u.id,
      at: u.createdAt,
      method: u.method,
      pages: u.pages,
      aiModel: u.aiModel,
      aiCalls: u.aiCalls,
      aiInputTokens: u.aiInputTokens,
      aiOutputTokens: u.aiOutputTokens,
      durationMs: u.durationMs,
      documentBytes: u.documentBytes,
    };
  }

  /** Failed invoices grouped by stage and reason: the recurring failures first. */
  async failures() {
    const rows = await this.db
      .select({
        stage: t.invoices.failedStage,
        reason: sql<string>`left(coalesce(${t.invoices.failureReason}, ''), 120)`,
        count: sql<number>`count(*)::int`,
        lastAt: sql<string>`max(${t.invoices.updatedAt})`,
      })
      .from(t.invoices)
      .where(eq(t.invoices.state, 'FAILED'))
      .groupBy(t.invoices.failedStage, sql`left(coalesce(${t.invoices.failureReason}, ''), 120)`)
      .orderBy(desc(sql`count(*)`))
      .limit(50);
    return rows.map((r) => ({
      ...r,
      reason: r.reason || null,
      lastAt: new Date(r.lastAt).toISOString(),
    }));
  }

  /** Retries a failed invoice from where it can safely resume; recorded in the platform trail. */
  async retry(id: string, reason: string, ctx: CommercialContext) {
    const why = this.reasonOf(reason);
    const moved = await this.d.veyra.retryForOperations(id);
    await this.d.commercial.event(
      this.db,
      'processing.retried',
      {
        organizationId: this.d.veyra.organizationId,
        subject: `invoice:${id}`,
        oldValue: { state: moved.from },
        newValue: { state: moved.to },
        reason: why,
      },
      ctx,
    );
    return moved;
  }

  // ── AI, usage and cost ───────────────────────────────────────────────────

  /**
   * One month's usage and estimated cost. Every reading is one ledger row (unique per extraction),
   * so a retried job cannot count twice; a re-read of the same invoice is real extra usage and is
   * counted as such. Invoices are counted once each, however many readings they needed.
   */
  async cost(at: Date = this.now()) {
    const month = monthOf(at);
    const [rows, pricing, org] = await Promise.all([
      this.db
        .select()
        .from(t.processingUsage)
        .where(
          and(
            gte(t.processingUsage.createdAt, month.from),
            lt(t.processingUsage.createdAt, month.to),
          ),
        ),
      this.pricing(),
      this.orgName(),
    ]);
    type Bucket = {
      key: string;
      readings: number;
      invoices: Set<string>;
      pages: number;
      aiCalls: number;
      aiInputTokens: number;
      aiOutputTokens: number;
      aiPaise: number;
      unpriced: number;
      durationMs: number;
      bytes: number;
    };
    const bucket = (key: string): Bucket => ({
      key,
      readings: 0,
      invoices: new Set(),
      pages: 0,
      aiCalls: 0,
      aiInputTokens: 0,
      aiOutputTokens: 0,
      aiPaise: 0,
      unpriced: 0,
      durationMs: 0,
      bytes: 0,
    });
    const total = bucket('all');
    const byMethod = new Map<string, Bucket>();
    const byModel = new Map<string, Bucket>();
    for (const r of rows) {
      const c = costOf(r, pricing);
      const add = (b: Bucket) => {
        b.readings += 1;
        b.invoices.add(r.invoiceId);
        b.pages += r.pages;
        b.aiCalls += r.aiCalls;
        b.aiInputTokens += r.aiInputTokens;
        b.aiOutputTokens += r.aiOutputTokens;
        if (c.aiPaise === null) b.unpriced += 1;
        else b.aiPaise += c.aiPaise;
        b.durationMs += r.durationMs ?? 0;
        b.bytes += r.documentBytes;
      };
      add(total);
      const m = byMethod.get(r.method) ?? bucket(r.method);
      add(m);
      byMethod.set(r.method, m);
      if (r.aiModel) {
        const g = byModel.get(r.aiModel) ?? bucket(r.aiModel);
        add(g);
        byModel.set(r.aiModel, g);
      }
    }
    const infraRate = pricing.infrastructurePerInvoicePaise;
    const view = (b: Bucket) => {
      const aiPaise = b.unpriced > 0 ? null : b.aiPaise;
      const infraPaise = infraRate === null ? null : infraRate * b.invoices.size;
      const totalPaise = aiPaise === null || infraPaise === null ? null : aiPaise + infraPaise;
      return {
        key: b.key,
        readings: b.readings,
        invoices: b.invoices.size,
        pages: b.pages,
        aiCalls: b.aiCalls,
        aiInputTokens: b.aiInputTokens,
        aiOutputTokens: b.aiOutputTokens,
        aiPaise,
        aiPaisePriced: b.aiPaise,
        unpricedReadings: b.unpriced,
        infrastructurePaise: infraPaise,
        totalPaise,
        perInvoicePaise:
          totalPaise === null || b.invoices.size === 0
            ? null
            : Math.round(totalPaise / b.invoices.size),
        avgDurationMs: b.readings ? Math.round(b.durationMs / b.readings) : null,
        storageBytes: b.bytes,
      };
    };
    const totals = view(total);
    const geminiReadings = rows.filter((r) => r.aiCalls > 0).length;
    return {
      month,
      pricing,
      totals,
      geminiPaise: totals.aiPaise,
      /** No reading in this version uses Document AI (local OCR and Gemini only). */
      documentAi: { pages: 0, paise: 0, used: false },
      geminiUsagePercent: rows.length ? Math.round((geminiReadings / rows.length) * 100) : null,
      byCustomer: rows.length
        ? [{ ...view(total), key: this.d.veyra.organizationId, name: org }]
        : [],
      byMethod: [...byMethod.values()].map(view).sort((a, b) => b.readings - a.readings),
      byModel: [...byModel.values()].map(view).sort((a, b) => b.readings - a.readings),
    };
  }

  /** The latest readings with their cost (the per-invoice ledger). */
  async usageLedger(limit = 200) {
    const [rows, pricing] = await Promise.all([
      this.db
        .select()
        .from(t.processingUsage)
        .orderBy(desc(t.processingUsage.seq))
        .limit(Math.min(limit, 500)),
      this.pricing(),
    ]);
    const infra = pricing.infrastructurePerInvoicePaise;
    return rows.map((u) => {
      const c = costOf(u, pricing);
      return {
        ...this.usageDto(u),
        invoiceId: u.invoiceId,
        customerId: this.d.veyra.organizationId,
        aiPaise: c.aiPaise,
        totalPaise: c.aiPaise === null || infra === null ? null : c.aiPaise + infra,
      };
    });
  }

  // ── System configuration ─────────────────────────────────────────────────

  async config() {
    const [settings, retention, readiness] = await Promise.all([
      this.d.veyra.settings(),
      this.d.veyra.retentionPolicy(),
      this.d.readiness ? this.d.readiness().catch(() => null) : Promise.resolve(null),
    ]);
    const models = this.d.aiModels;
    return {
      environment: this.d.environment,
      ai: {
        provider: models.length ? 'Google Gemini' : null,
        configured: models.length > 0,
        model: models[0] ?? null,
        backupModels: models.slice(1),
        reader: settings.extractorMode,
        localOcr: true,
        documentAi: false,
      },
      confidenceMinBp: settings.confidenceMinBp,
      confidenceRange: CONFIDENCE_RANGE,
      retention,
      email: { configured: false, note: 'No email service is integrated in this version.' },
      limits: {
        maxUploadBytes: this.d.limits.maxUploadBytes,
        rateLimitsPerMinute: this.d.limits.rateLimitsPerMinute,
        stuckAfterMinutes: STUCK_AFTER_MS / 60_000,
      },
      autoCreatePo: {
        enabled: settings.poAutoCreateEnabled,
        belowPaise: settings.poAutoCreateBelowPaise,
      },
      health: readiness,
      organizationsPerDeployment: 1,
    };
  }

  async setConfidence(value: number, reason: string, ctx: CommercialContext): Promise<void> {
    const why = this.reasonOf(reason);
    if (!Number.isInteger(value) || value < CONFIDENCE_RANGE.min || value > CONFIDENCE_RANGE.max)
      throw new VeyraError(
        'INVALID_INPUT',
        `The confidence threshold is between ${CONFIDENCE_RANGE.min / 100}% and ${CONFIDENCE_RANGE.max / 100}%.`,
      );
    await this.db.transaction(async (tx) => {
      const db = tx as unknown as VeyraDb;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${CONFIDENCE_KEY}))`);
      const before = (await this.d.veyra.settings(db)).confidenceMinBp;
      if (before === value) throw new VeyraError('INVALID_STATE', 'That is already the threshold.');
      await this.writeSetting(db, CONFIDENCE_KEY, value, ctx.actorUserId);
      await this.d.commercial.event(
        db,
        'config.changed',
        {
          subject: 'setting:confidenceMinBp',
          oldValue: before,
          newValue: value,
          reason: why,
        },
        ctx,
      );
    });
  }

  // ── Audit ────────────────────────────────────────────────────────────────

  async audit(f: { organizationId?: string; event?: string; q?: string } = {}) {
    const all = await this.d.commercial.events({
      ...(f.organizationId ? { organizationId: f.organizationId } : {}),
      limit: 500,
    });
    const needle = f.q?.trim().toLowerCase() ?? '';
    return all.filter(
      (e) =>
        (!f.event || e.event === f.event) &&
        (!needle ||
          [e.subject, e.organizationId, e.planKey, e.capability, e.actor, e.reason]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(needle)),
    );
  }

  /** The customer's usage snapshot (for tests and the customer detail). */
  usage() {
    return usageOf(this.db, this.d.veyra.organizationId, this.now());
  }
}

/** Where an invoice is, per phase, from its state (no extra bookkeeping). */
export function stagesOf(state: string, failedStage: string | null) {
  type S = 'waiting' | 'running' | 'done' | 'needs_input' | 'failed' | 'rejected' | 'n/a';
  const failedAt = state === 'FAILED' ? (failedStage ?? 'EXTRACTING') : null;
  const extraction: S =
    failedAt === 'EXTRACTING' || failedAt === 'UPLOADED'
      ? 'failed'
      : state === 'UPLOADED'
        ? 'waiting'
        : state === 'EXTRACTING'
          ? 'running'
          : 'done';
  const verification: S =
    extraction !== 'done'
      ? extraction === 'failed'
        ? 'n/a'
        : 'waiting'
      : failedAt === 'MATCHING' || failedAt === 'VALIDATING'
        ? 'failed'
        : state === 'MATCHING' || state === 'VALIDATING'
          ? 'running'
          : 'done';
  const resolution: S =
    state === 'NEEDS_INPUT' || state === 'RESOLVING'
      ? 'needs_input'
      : state === 'REJECTED'
        ? 'rejected'
        : state === 'VERIFIED_PENDING_PAYMENT'
          ? 'done'
          : state === 'COMMITTING'
            ? 'running'
            : failedAt === 'COMMITTING' || failedAt === 'RESOLVING'
              ? 'failed'
              : verification === 'done'
                ? 'done'
                : 'waiting';
  return { extraction, verification, resolution };
}
