import { and, eq, isNull } from 'drizzle-orm';
import {
  CAPABILITIES,
  capabilityDefinition,
  type CapabilityDefinition,
  type CapabilityKey,
  type EntitlementSource,
  type EntitlementValue,
} from '@veyra/shared';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';

/**
 * The one place that decides what an organization may use (Phase 8A,
 * docs/COMMERCIAL_ENTITLEMENTS.md):
 *
 *   PLAN → PLAN ENTITLEMENTS → ORGANIZATION → OVERRIDES → EFFECTIVE CAPABILITY → SERVER CHECK
 *
 * Precedence, per capability key, evaluated at the moment of the check:
 *   1. an active organization override (not revoked, not expired),
 *   2. else the organization's plan entitlement,
 *   3. else nothing: unavailable (BOOLEAN off, LIMIT 0).
 * Safety rules (validation, security, ERP technical capability, audit) are not entitlements and are
 * applied by their own code whatever this says: an entitlement grants access, never an exemption.
 *
 * Every commercially controlled feature asks here, by key. Nothing else reads plans.
 *
 * Cache: an organization's plan and override rows are cached for `ttlMs` (default 5 s), keyed by
 * organization id. A change made through CommercialAdmin invalidates it at once in this process;
 * another process sees it within `ttlMs`. Expiry is evaluated on every check against the clock, never
 * cached: an override that expires is ineffective from that millisecond, with no clean-up job.
 */
export const ENTITLEMENT_CACHE_MS = 5_000;

/**
 * The plan a NEW deployment's organization starts on (a bootstrap default, not a business rule:
 * nothing checks for it). Veyra Operations assigns the real plan, audited.
 */
export const INITIAL_PLAN = 'ENTERPRISE';

export class NotEntitledError extends Error {
  readonly code = 'NOT_ENTITLED';
  constructor(readonly capability: CapabilityKey) {
    super('This is not included in your Veyrafy plan.');
    this.name = 'NotEntitledError';
  }
}

export class LimitReachedError extends Error {
  readonly code = 'LIMIT_REACHED';
  constructor(
    readonly capability: CapabilityKey,
    message: string,
  ) {
    super(message);
    this.name = 'LimitReachedError';
  }
}

interface ValueRow {
  enabled: boolean | null;
  limitValue: number | null;
}
interface OverrideRow extends ValueRow {
  id: string;
  capability: string;
  unlimited: boolean;
  reason: string;
  expiresAt: string | null;
  createdByUserId: string;
  createdAt: string;
}
interface Loaded {
  planKey: string | null;
  plan: Map<string, ValueRow>;
  overrides: Map<string, OverrideRow>;
}

export interface Effective {
  capability: CapabilityKey;
  definition: CapabilityDefinition;
  plan: EntitlementValue | null;
  override: {
    row: OverrideRow;
    value: EntitlementValue;
    expired: boolean;
  } | null;
  effective: EntitlementValue;
  source: EntitlementSource;
}

const NONE = (def: CapabilityDefinition): EntitlementValue =>
  def.type === 'BOOLEAN' ? { enabled: false } : { limit: 0 };

function planValue(def: CapabilityDefinition, row: ValueRow | undefined): EntitlementValue | null {
  if (!row) return null;
  return def.type === 'BOOLEAN'
    ? { enabled: row.enabled === true }
    : { limit: row.limitValue === null ? null : Number(row.limitValue) };
}

function overrideValue(def: CapabilityDefinition, row: OverrideRow): EntitlementValue {
  return def.type === 'BOOLEAN'
    ? { enabled: row.enabled === true }
    : { limit: row.unlimited ? null : Number(row.limitValue ?? 0) };
}

export class Entitlements {
  readonly #cache = new Map<string, { at: number; loaded: Promise<Loaded> }>();

  constructor(
    private readonly db: VeyraDb,
    private readonly clock: () => Date = () => new Date(),
    private readonly ttlMs = ENTITLEMENT_CACHE_MS,
  ) {}

  /** Forgets an organization's cached rows (after any commercial change). */
  invalidate(organizationId?: string): void {
    if (organizationId === undefined) this.#cache.clear();
    else this.#cache.delete(organizationId);
  }

  /** Two queries per organization per cache window, whatever the number of checks. */
  #load(organizationId: string): Promise<Loaded> {
    const now = Date.now();
    const hit = this.#cache.get(organizationId);
    if (hit && now - hit.at < this.ttlMs) return hit.loaded;
    const loaded = (async (): Promise<Loaded> => {
      const [planRows, overrideRows] = await Promise.all([
        this.db
          .select({
            planKey: t.organizations.planKey,
            capability: t.planEntitlements.capability,
            enabled: t.planEntitlements.enabled,
            limitValue: t.planEntitlements.limitValue,
          })
          .from(t.organizations)
          .leftJoin(t.planEntitlements, eq(t.planEntitlements.planKey, t.organizations.planKey))
          .where(eq(t.organizations.id, organizationId)),
        this.db
          .select({
            id: t.entitlementOverrides.id,
            capability: t.entitlementOverrides.capability,
            enabled: t.entitlementOverrides.enabled,
            limitValue: t.entitlementOverrides.limitValue,
            unlimited: t.entitlementOverrides.unlimited,
            reason: t.entitlementOverrides.reason,
            expiresAt: t.entitlementOverrides.expiresAt,
            createdByUserId: t.entitlementOverrides.createdByUserId,
            createdAt: t.entitlementOverrides.createdAt,
          })
          .from(t.entitlementOverrides)
          .where(
            and(
              eq(t.entitlementOverrides.organizationId, organizationId),
              isNull(t.entitlementOverrides.revokedAt),
            ),
          ),
      ]);
      const plan = new Map<string, ValueRow>();
      for (const r of planRows)
        if (r.capability) plan.set(r.capability, { enabled: r.enabled, limitValue: r.limitValue });
      return {
        planKey: planRows[0]?.planKey ?? null,
        plan,
        overrides: new Map(overrideRows.map((o) => [o.capability, o])),
      };
    })();
    // A failed load is not cached: the next check tries again.
    loaded.catch(() => this.#cache.delete(organizationId));
    this.#cache.set(organizationId, { at: now, loaded });
    return loaded;
  }

  #resolve(def: CapabilityDefinition, loaded: Loaded, now: number): Effective {
    const plan = planValue(def, loaded.plan.get(def.key));
    const row = loaded.overrides.get(def.key);
    const override = row
      ? {
          row,
          value: overrideValue(def, row),
          expired: row.expiresAt !== null && Date.parse(row.expiresAt) <= now,
        }
      : null;
    const [effective, source]: [EntitlementValue, EntitlementSource] =
      override && !override.expired
        ? [override.value, 'override']
        : plan
          ? [plan, 'plan']
          : [NONE(def), 'none'];
    return {
      capability: def.key as CapabilityKey,
      definition: def,
      plan,
      override,
      effective,
      source,
    };
  }

  /** Every capability of the catalogue, resolved (the operator's "why" view). */
  async all(organizationId: string): Promise<Effective[]> {
    const loaded = await this.#load(organizationId);
    const now = this.clock().getTime();
    return (CAPABILITIES as readonly CapabilityDefinition[]).map((def) =>
      this.#resolve(def, loaded, now),
    );
  }

  async get(organizationId: string, key: CapabilityKey): Promise<Effective> {
    const def = capabilityDefinition(key);
    if (!def) throw new Error(`unknown capability ${key}`);
    return this.#resolve(def, await this.#load(organizationId), this.clock().getTime());
  }

  /** A BOOLEAN capability is on (a LIMIT is "usable" when above 0 or unlimited). */
  async can(organizationId: string, key: CapabilityKey): Promise<boolean> {
    const { effective } = await this.get(organizationId, key);
    return 'enabled' in effective ? effective.enabled : effective.limit !== 0;
  }

  /** Throws NotEntitledError when the capability is not available. */
  async require(organizationId: string, key: CapabilityKey): Promise<void> {
    if (!(await this.can(organizationId, key))) throw new NotEntitledError(key);
  }

  /** A LIMIT's effective quota: a number, or null for unlimited (0 when not entitled). */
  async limit(organizationId: string, key: CapabilityKey): Promise<number | null> {
    const { effective } = await this.get(organizationId, key);
    if (!('limit' in effective)) throw new Error(`${key} is not a limit`);
    return effective.limit;
  }

  /**
   * Throws LimitReachedError when `used + adding` would exceed the quota. Never processes beyond
   * a limit; the message is a business message, without plan or implementation detail.
   */
  async requireWithin(
    organizationId: string,
    key: CapabilityKey,
    used: number,
    adding: number,
    message: string,
  ): Promise<void> {
    const limit = await this.limit(organizationId, key);
    if (limit !== null && used + adding > limit) throw new LimitReachedError(key, message);
  }

  /** The plan an organization is on (cached with its entitlements). */
  async planKey(organizationId: string): Promise<string | null> {
    return (await this.#load(organizationId)).planKey;
  }
}
