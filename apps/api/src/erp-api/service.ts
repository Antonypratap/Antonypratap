import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import {
  ErpConfigurationError,
  ErpConnectorError,
  type Company,
  type ErpConnectionCheck,
} from '@veyra/erp-connector';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';
import { ulid } from '../ids';
import type { Secret } from '../secret';
import {
  DEFAULT_HTTP_POLICY,
  ResilientHttp,
  isBlockedAddress,
  networkTransport,
  type HttpPolicy,
  type Transport,
} from './http';
import { mappingHash } from './mapping';
import { MirrorIndex, MirroredErpConnector, type MirrorRow } from './mirror';
import { AUTH_SECRET, ENTITIES, ProfileSchema, type Entity, type Profile } from './profile';
import { SecretBox, SecretsKeyError } from './secrets';
import { GenericApiSource, ResponseShapeError } from './source';
import { ErpSync, SyncBusyError, type SyncResult, type SyncTrigger } from './sync';

/**
 * The business's ERP connection over its API (docs/ERP-API.md): the stored profile and encrypted
 * credentials, syncing into the mirror, the mirror's freshness, and whether invoice checks use it.
 * One connection per deployment. Read-only towards the ERP in this phase.
 */

const CONNECTION_ID = 'erp-api';
/** Record types a check relies on; purchase bills are optional (the duplicate check uses them). */
export const REQUIRED_ENTITIES: readonly Entity[] = ['vendors', 'items', 'purchase_orders', 'grns'];

export interface ErpApiOptions {
  db: VeyraDb;
  now: () => string;
  /** VEYRA_SECRETS_KEY; without it credentials cannot be saved (and no connection can log in). */
  secretsKey: Secret | null;
  /** VEYRA_SECRETS_KEYS_PREVIOUS: earlier keys, read (never written) during a rotation. */
  previousSecretsKeys?: Secret | null;
  http?: Partial<HttpPolicy>;
  /** The transport for a profile: the network, or an in-process one (the built-in Sample ERP). */
  transportFor?: (profile: Profile, policy: HttpPolicy) => Transport;
  /** Records older than this hold invoice checks (minutes). */
  maxAgeMinutes?: number;
  /** After a failed or partial sync, invoice checks wait this long before trying another (ms). */
  retryAfterFailureMs?: number;
  /** The business this deployment serves (the built-in records' company). */
  company: () => Promise<Company>;
}

export type AuditFn = (
  tx: VeyraDb,
  event: string,
  detail: Record<string, unknown>,
  userId: string | null,
) => Promise<void>;

export interface Freshness {
  /** True when every required record type had a complete, trusted sync within the limit. */
  fresh: boolean;
  /** The oldest complete sync among the required types (null: one was never synced). */
  syncedAt: string | null;
  /** Record types that are not fresh. */
  stale: Entity[];
}

export class ErpApi {
  readonly #o: Required<Omit<ErpApiOptions, 'http' | 'secretsKey' | 'previousSecretsKeys'>> & {
    policy: HttpPolicy;
  };
  readonly #box: SecretBox | null;
  #audit: AuditFn = () => Promise.resolve();
  #afterSync: (changed: boolean) => Promise<void> = () => Promise.resolve();
  #index: MirrorIndex | null = null;
  #active = false;
  #activeCheckedAt = 0;
  #inFlight: Promise<SyncResult> | null = null;
  #source: GenericApiSource | null = null;
  readonly connector: MirroredErpConnector;

  constructor(options: ErpApiOptions) {
    this.#o = {
      transportFor: (_p, policy) => networkTransport(policy),
      maxAgeMinutes: 60,
      retryAfterFailureMs: 2 * 60_000,
      ...options,
      policy: { ...DEFAULT_HTTP_POLICY, ...options.http },
    };
    this.#box = options.secretsKey
      ? SecretBox.fromBase64(options.secretsKey, options.previousSecretsKeys ?? null)
      : null;
    this.connector = new MirroredErpConnector({
      index: () => this.index(),
      company: () => this.#o.company(),
      check: () => this.check(),
      displayName: () => this.#displayName,
    });
  }

  #displayName = 'Your ERP';

  /** Late wiring: the audit trail and the re-check of held invoices live in Veyra. */
  attach(audit: AuditFn, afterSync: (changed: boolean) => Promise<void>): void {
    this.#audit = audit;
    this.#afterSync = afterSync;
  }

  get canStoreSecrets(): boolean {
    return this.#box !== null;
  }

  async init(): Promise<void> {
    const row = await this.#row();
    this.#active = row?.active ?? false;
    this.#activeCheckedAt = Date.now();
    if (row) this.#displayName = (JSON.parse(row.profileJson) as Profile).name;
  }

  /** Whether invoice checks use the ERP connection (cached for a few seconds, see refreshActive). */
  isActive(): boolean {
    if (Date.now() - this.#activeCheckedAt > 5_000) void this.refreshActive();
    return this.#active;
  }

  async refreshActive(): Promise<boolean> {
    const row = await this.#row();
    this.#active = row?.active ?? false;
    this.#activeCheckedAt = Date.now();
    return this.#active;
  }

  async #row() {
    const [row] = await this.#o.db
      .select()
      .from(t.erpConnections)
      .where(eq(t.erpConnections.id, CONNECTION_ID));
    return row ?? null;
  }

  async profile(): Promise<{
    profile: Profile;
    version: number;
    active: boolean;
    updatedAt: string;
  } | null> {
    const row = await this.#row();
    if (!row) return null;
    return {
      profile: ProfileSchema.parse(JSON.parse(row.profileJson)),
      version: row.version,
      active: row.active,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Saves the profile. Changing the ERP's address or the login method forgets the saved secret:
   * a secret is never sent to an address it was not saved for. Pointing at another ERP (its
   * address) or another company/outlet (the scope) forgets every synced record, and invoice checks
   * stop using the connection until a new complete sync: records of one ERP are never used for
   * another. A record type whose mapping changed is read again in full by the next sync.
   */
  async saveProfile(
    input: unknown,
    userId: string | null,
  ): Promise<{ profile: Profile; reset: boolean; wasActive: boolean }> {
    const profile = ProfileSchema.parse(input);
    const old = await this.profile();
    const origin = (p: Profile) => {
      try {
        return (
          new URL(p.baseUrl).origin +
          '|' +
          p.auth.type +
          '|' +
          (p.auth.type === 'oauth2_client_credentials' ? new URL(p.auth.tokenUrl).origin : '')
        );
      } catch {
        return p.baseUrl;
      }
    };
    const resetSecrets = old !== null && origin(old.profile) !== origin(profile);
    const reset =
      old !== null &&
      (old.profile.baseUrl !== profile.baseUrl ||
        JSON.stringify(old.profile.scope) !== JSON.stringify(profile.scope));
    // Record types read with a different mapping (or no longer read at all).
    const remapped = old
      ? ENTITIES.filter((e) => {
          const before = old.profile.entities[e];
          const after = profile.entities[e];
          if (!before) return false;
          return (
            !after || mappingHash(before, old.profile.scope) !== mappingHash(after, profile.scope)
          );
        })
      : [];
    const dropped = old
      ? ENTITIES.filter((e) => old.profile.entities[e] && !profile.entities[e])
      : [];
    const wasActive = old?.active ?? false;
    const now = this.#o.now();
    await this.#o.db.transaction(async (tx) => {
      if (old)
        await tx
          .update(t.erpConnections)
          .set({
            profileJson: JSON.stringify(profile),
            version: old.version + 1,
            ...(reset ? { active: false } : {}),
            updatedByUserId: userId,
            updatedAt: now,
          })
          .where(eq(t.erpConnections.id, CONNECTION_ID));
      else
        await tx.insert(t.erpConnections).values({
          id: CONNECTION_ID,
          profileJson: JSON.stringify(profile),
          active: false,
          version: 1,
          updatedByUserId: userId,
          updatedAt: now,
        });
      if (resetSecrets)
        await tx.delete(t.erpCredentials).where(eq(t.erpCredentials.connectionId, CONNECTION_ID));
      const mine = (
        table: typeof t.erpSyncRecords | typeof t.erpSyncState | typeof t.erpSyncIssues,
      ) => eq(table.connectionId, CONNECTION_ID);
      if (reset) {
        // Another ERP or company: nothing synced so far belongs to it (runs stay, for the record).
        await tx.delete(t.erpSyncIssues).where(mine(t.erpSyncIssues));
        await tx.delete(t.erpSyncRecords).where(mine(t.erpSyncRecords));
        await tx.delete(t.erpSyncState).where(mine(t.erpSyncState));
      } else {
        if (remapped.length > 0)
          await tx
            .delete(t.erpSyncState)
            .where(and(mine(t.erpSyncState), inArray(t.erpSyncState.entity, remapped)));
        if (dropped.length > 0)
          await tx
            .delete(t.erpSyncRecords)
            .where(and(mine(t.erpSyncRecords), inArray(t.erpSyncRecords.entity, dropped)));
      }
      await this.#audit(
        tx,
        'erp.connection_saved',
        {
          name: profile.name,
          authType: profile.auth.type,
          secretsCleared: resetSecrets,
          recordsCleared: reset,
          remapped,
          entities: Object.keys(profile.entities),
        },
        userId,
      );
      if (reset && wasActive) await this.#audit(tx, 'erp.connection_deactivated', {}, userId);
    });
    this.#displayName = profile.name;
    this.#source = null;
    this.#index = null;
    if (reset) {
      this.#active = false;
      this.#activeCheckedAt = Date.now();
    }
    return { profile, reset, wasActive };
  }

  /** Saves (encrypted) the secret the profile's login method needs. Never returned. */
  async saveSecret(value: string, userId: string | null): Promise<void> {
    if (!this.#box)
      throw new SecretsKeyError(
        'Credentials cannot be saved: VEYRA_SECRETS_KEY is not set on this Veyrafy.',
      );
    const current = await this.profile();
    if (!current) throw new ErpConfigurationError();
    const spec = AUTH_SECRET[current.profile.auth.type];
    if (!spec) return;
    const sealed = this.#box.seal(value, `erp:${CONNECTION_ID}:${spec.key}`);
    const now = this.#o.now();
    await this.#o.db.transaction(async (tx) => {
      await tx
        .insert(t.erpCredentials)
        .values({
          connectionId: CONNECTION_ID,
          name: spec.key,
          ...sealed,
          updatedByUserId: userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [t.erpCredentials.connectionId, t.erpCredentials.name],
          set: { ...sealed, updatedByUserId: userId, updatedAt: now },
        });
      // Which secret, never its value.
      await this.#audit(tx, 'erp.credentials_updated', { name: spec.key }, userId);
    });
    this.#source = null;
  }

  /**
   * Key rotation: re-encrypts every saved credential still sealed with an earlier key, with the
   * current VEYRA_SECRETS_KEY. Audited by count only. Returns how many were re-encrypted.
   */
  async resealSecrets(): Promise<number> {
    if (!this.#box) return 0;
    const box = this.#box;
    const rows = await this.#o.db
      .select()
      .from(t.erpCredentials)
      .where(eq(t.erpCredentials.connectionId, CONNECTION_ID));
    const stale = rows.filter((r) => box.isStale(r));
    if (stale.length === 0) return 0;
    await this.#o.db.transaction(async (tx) => {
      for (const r of stale) {
        const purpose = `erp:${CONNECTION_ID}:${r.name}`;
        const sealed = box.seal(box.open(r, purpose).reveal(), purpose);
        await tx
          .update(t.erpCredentials)
          .set(sealed)
          .where(
            and(
              eq(t.erpCredentials.connectionId, CONNECTION_ID),
              eq(t.erpCredentials.name, r.name),
            ),
          );
      }
      await this.#audit(tx, 'erp.credentials_rekeyed', { count: stale.length }, null);
    });
    this.#source = null;
    return stale.length;
  }

  /** Which secrets are saved, and when (never the values). */
  async secretStatus(): Promise<{ name: string; label: string; savedAt: string | null } | null> {
    const current = await this.profile();
    const spec = current ? AUTH_SECRET[current.profile.auth.type] : null;
    if (!spec) return null;
    const [row] = await this.#o.db
      .select({ updatedAt: t.erpCredentials.updatedAt })
      .from(t.erpCredentials)
      .where(
        and(eq(t.erpCredentials.connectionId, CONNECTION_ID), eq(t.erpCredentials.name, spec.key)),
      );
    return { name: spec.key, label: spec.label, savedAt: row?.updatedAt ?? null };
  }

  async #secrets(): Promise<Map<string, Secret>> {
    const rows = await this.#o.db
      .select()
      .from(t.erpCredentials)
      .where(eq(t.erpCredentials.connectionId, CONNECTION_ID));
    const out = new Map<string, Secret>();
    if (!this.#box) return out;
    for (const r of rows) out.set(r.name, this.#box.open(r, `erp:${CONNECTION_ID}:${r.name}`));
    return out;
  }

  /** A source for the saved profile and secrets (rebuilt after either changes). */
  async source(profileOverride?: Profile): Promise<GenericApiSource> {
    if (!profileOverride && this.#source) return this.#source;
    const current = profileOverride ?? (await this.profile())?.profile;
    if (!current) throw new ErpConfigurationError();
    const secrets = await this.#secrets();
    const http = new ResilientHttp(this.#o.transportFor(current, this.#o.policy), this.#o.policy);
    const source = new GenericApiSource(current, (k) => secrets.get(k) ?? null, http);
    if (!profileOverride) this.#source = source;
    return source;
  }

  // ── Sync ─────────────────────────────────────────────────────────────────

  #sync(): ErpSync {
    return new ErpSync({
      db: this.#o.db,
      connectionId: CONNECTION_ID,
      now: this.#o.now,
      newId: () => ulid(),
      audit: (tx, event, detail, userId) => this.#audit(tx, event, detail, userId),
    });
  }

  /** One sync; concurrent calls in this process share it. Throws SyncBusyError when another process holds the lease. */
  sync(trigger: SyncTrigger, userId: string | null): Promise<SyncResult> {
    this.#inFlight ??= this.#runSync(trigger, userId).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  get syncing(): boolean {
    return this.#inFlight !== null;
  }

  async #runSync(trigger: SyncTrigger, userId: string | null): Promise<SyncResult> {
    const source = await this.source();
    const result = await this.#sync().run(source, trigger, userId);
    this.#index = null;
    // Whether any record was added, changed or found missing (invoices waiting on the ERP are
    // checked again only then).
    const changed = Object.values(result.counts).some((c) => c.changed > 0 || c.missing > 0);
    if (result.status !== 'failed') await this.#afterSync(changed).catch(() => undefined);
    return result;
  }

  /**
   * Brings the mirror up to date before a check when it is older than the limit (never throws).
   * After a failed or partial sync it waits a while before trying again, so an ERP that is down
   * is not called once for every invoice waiting to be checked.
   */
  async refreshIfStale(): Promise<void> {
    if (!this.isActive()) return;
    const f = await this.freshness();
    if (f.fresh) return;
    const [last] = await this.#lastRun();
    if (
      last &&
      last.status !== 'succeeded' &&
      last.finishedAt &&
      Date.parse(this.#o.now()) - Date.parse(last.finishedAt) < this.#o.retryAfterFailureMs
    )
      return;
    await this.sync('before_check', null).catch(() => undefined);
  }

  async freshness(): Promise<Freshness> {
    const rows = await this.#o.db
      .select()
      .from(t.erpSyncState)
      .where(eq(t.erpSyncState.connectionId, CONNECTION_ID));
    const cutoff = Date.parse(this.#o.now()) - this.#o.maxAgeMinutes * 60_000;
    const stale: Entity[] = [];
    let oldest: string | null = null;
    let never = false;
    for (const e of REQUIRED_ENTITIES) {
      const s = rows.find((r) => r.entity === e);
      if (!s?.lastCompleteAt) {
        stale.push(e);
        never = true;
        continue;
      }
      if (Date.parse(s.lastCompleteAt) < cutoff) stale.push(e);
      if (oldest === null || s.lastCompleteAt < oldest) oldest = s.lastCompleteAt;
    }
    // A record type whose last pass was not trusted (too many unreadable records) is not fresh.
    const [last] = await this.#lastRun();
    if (last && last.status !== 'running') {
      const counts = JSON.parse(last.countsJson) as Partial<Record<Entity, { status: string }>>;
      for (const e of REQUIRED_ENTITIES)
        if (counts[e] && counts[e].status !== 'complete' && !stale.includes(e)) stale.push(e);
    }
    return { fresh: stale.length === 0, syncedAt: never ? null : oldest, stale };
  }

  #lastRun() {
    return this.#o.db
      .select()
      .from(t.erpSyncRuns)
      .where(
        and(eq(t.erpSyncRuns.connectionId, CONNECTION_ID), ne(t.erpSyncRuns.status, 'running')),
      )
      .orderBy(desc(t.erpSyncRuns.seq))
      .limit(1);
  }

  /** The mirror as records (rebuilt after each sync). */
  async index(): Promise<MirrorIndex> {
    if (this.#index) return this.#index;
    const rows = await this.#o.db
      .select()
      .from(t.erpSyncRecords)
      .where(eq(t.erpSyncRecords.connectionId, CONNECTION_ID));
    const profile = (await this.profile())?.profile;
    const scoped = rows.filter(
      (r) =>
        (!profile?.scope.companyValue || r.company === profile.scope.companyValue) &&
        (!profile?.scope.outletValue || r.outlet === profile.scope.outletValue),
    );
    this.#index = new MirrorIndex(
      scoped.map((r): MirrorRow => ({
        entity: r.entity as Entity,
        erpId: r.erpId,
        company: r.company,
        outlet: r.outlet,
        doc: JSON.parse(r.docJson) as MirrorRow['doc'],
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        lastChangedRunId: r.lastChangedRunId,
        missingSince: r.missingSince,
      })),
    );
    return this.#index;
  }

  /** Where these ERP records came from and when each was last synced (traceability). */
  async provenance(
    erpIds: readonly string[],
  ): Promise<{ entity: Entity; erpId: string; syncedAt: string }[]> {
    const index = await this.index();
    const out: { entity: Entity; erpId: string; syncedAt: string }[] = [];
    for (const id of erpIds)
      for (const e of ENTITIES) {
        const p = index.provenance.get(`${e}:${id}`);
        if (p) out.push(p);
      }
    return out;
  }

  // ── Use for checks ───────────────────────────────────────────────────────

  /** Invoice checks use the ERP connection from now on (needs a fresh, complete sync). */
  async activate(userId: string | null): Promise<void> {
    await this.#refuseWhileCommitting();
    const f = await this.freshness();
    if (!f.fresh) throw new ErpConfigurationError();
    await this.#setActive(true, userId);
  }

  /** Invoice checks use the built-in records again (they were never changed). */
  async deactivate(userId: string | null): Promise<void> {
    await this.#refuseWhileCommitting();
    await this.#setActive(false, userId);
  }

  /**
   * An invoice being recorded was planned against the records in use: switching under it would
   * send its writes to the other side (refused there), so a switch waits until none is.
   */
  async #refuseWhileCommitting(): Promise<void> {
    const [busy] = await this.#o.db
      .select({ id: t.invoices.id })
      .from(t.invoices)
      .where(eq(t.invoices.state, 'COMMITTING'))
      .limit(1);
    if (busy) throw new ErpSwitchBusyError();
  }

  async #setActive(active: boolean, userId: string | null): Promise<void> {
    await this.#o.db.transaction(async (tx) => {
      await tx
        .update(t.erpConnections)
        .set({ active, updatedByUserId: userId, updatedAt: this.#o.now() })
        .where(eq(t.erpConnections.id, CONNECTION_ID));
      await this.#audit(
        tx,
        active ? 'erp.connection_activated' : 'erp.connection_deactivated',
        {},
        userId,
      );
    });
    this.#active = active;
    this.#activeCheckedAt = Date.now();
  }

  // ── Status ───────────────────────────────────────────────────────────────

  /** Connection status for the ERP screen and health (never throws). */
  async check(): Promise<ErpConnectionCheck> {
    try {
      const f = await this.freshness();
      const company = await this.#o.company();
      const [last] = await this.#lastRun();
      if (last?.errorCode === 'ERP_AUTHENTICATION_FAILED')
        return { status: 'AUTHENTICATION_FAILED', company: null };
      if (last?.status === 'failed') return { status: 'UNAVAILABLE', company: null };
      if (!f.fresh) return { status: 'UNKNOWN', company: null };
      return { status: 'CONNECTED', company: { name: company.name, identifier: company.gstin } };
    } catch {
      return { status: 'UNKNOWN', company: null };
    }
  }

  async lastRuns(limit = 5) {
    return this.#o.db
      .select()
      .from(t.erpSyncRuns)
      .where(eq(t.erpSyncRuns.connectionId, CONNECTION_ID))
      .orderBy(desc(t.erpSyncRuns.seq))
      .limit(limit);
  }

  /** Issues of the last finished run, plus what the records themselves cannot support. */
  async issues() {
    const [last] = await this.#lastRun();
    const fromRun = last
      ? await this.#o.db
          .select()
          .from(t.erpSyncIssues)
          .where(eq(t.erpSyncIssues.runId, last.id))
          .limit(500)
      : [];
    const index = await this.index();
    return [
      ...fromRun.map((i) => ({
        entity: i.entity as Entity,
        erpId: i.erpId,
        kind: i.kind as 'invalid' | 'shape_changed',
        detail: JSON.parse(i.detailJson) as string[],
      })),
      ...index.issues.slice(0, 500),
    ];
  }

  /** Counts of usable records per type (for the status card). */
  async recordCounts(): Promise<Record<Entity, number>> {
    const i = await this.index();
    return {
      vendors: i.vendors.size,
      items: i.items.size,
      purchase_orders: i.pos.size,
      grns: i.grns.size,
      bills: i.bills.length,
    };
  }

  static readonly ENTITIES = ENTITIES;
  static isBusy(e: unknown): boolean {
    return e instanceof SyncBusyError;
  }
}

export class ErpSwitchBusyError extends Error {
  constructor() {
    super('An invoice is being recorded right now. Try again in a moment.');
    this.name = 'ErpSwitchBusyError';
  }
}

/** A plain-words reason for a failed connection test or sync (no host, no secret). */
export function connectionErrorText(e: unknown): { code: string; message: string } {
  if (isBlockedAddress(e))
    return {
      code: 'BLOCKED_ADDRESS',
      message:
        'That address is inside a private network. Veyrafy only connects to ERPs on the internet.',
    };
  if (e instanceof ResponseShapeError) return { code: 'SHAPE', message: e.message };
  if (e instanceof SecretsKeyError) return { code: 'SECRETS_KEY', message: e.message };
  if (e instanceof ErpConnectorError) {
    switch (e.code) {
      case 'AUTHENTICATION_FAILED':
        return { code: e.code, message: 'Your ERP refused the login. Check the credentials.' };
      case 'CONFIGURATION_ERROR':
        return {
          code: e.code,
          message: 'Your ERP did not accept the request. Check the address and the path.',
        };
      case 'UNAVAILABLE':
        return { code: e.code, message: e.message + '. Try again in a few minutes.' };
      default:
        return { code: e.code, message: e.userMessage };
    }
  }
  return { code: 'UNKNOWN', message: 'Something went wrong talking to your ERP.' };
}
