import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  ErpAuthenticationError,
  ErpConnectorError,
  ErpUnavailableError,
} from '@veyra/erp-connector';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';
import { mappingHash, type MappedRecord } from './mapping';
import { ENTITIES, type Entity } from './profile';
import { ResponseShapeError, type GenericApiSource } from './source';

/**
 * One sync of the ERP's records into the mirror (erp_sync_records).
 *
 * - One at a time per connection: a run holds a lease (a `running` row, unique per connection,
 *   kept alive by a heartbeat). A lease whose heartbeat stopped is closed as `interrupted`.
 * - Page by page: each page's records and the place to continue from are committed together, so
 *   an interrupted or failed sync continues where it stopped (from the previous run's checkpoint).
 * - Idempotent: a record is keyed by the ERP's id within its type and company/outlet; it is
 *   written only when its content (raw hash) changed. Repeating a sync changes nothing.
 * - Incremental where the record type is set up for it ("changed since" the last complete pass);
 *   otherwise a full pass, after which records the ERP no longer returns are marked missing (never
 *   deleted, so a finding still shows what it was checked against).
 * - A record type with too many unreadable records (a changed API, a wrong mapping) is not
 *   trusted: its pass does not count as complete, so invoices that need it are held as stale.
 * - Authentication failure or the ERP being unavailable ends the run as failed; what was synced
 *   stays, and the next run continues from the checkpoint.
 */

export type SyncTrigger = 'manual' | 'scheduled' | 'before_check';
export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
export type EntityStatus = 'pending' | 'complete' | 'untrusted' | 'shape_changed' | 'failed';

export interface EntityCounts {
  received: number;
  mapped: number;
  changed: number;
  unchanged: number;
  invalid: number;
  outOfScope: number;
  missing: number;
  pages: number;
  status: EntityStatus;
}

interface Checkpoint {
  /** The run whose pass this is (records seen in the pass carry it). */
  passId: string;
  passStartedAt: string;
  /** "Changed since" for this pass; null for a full pass. */
  since: string | null;
  cursor: string | null;
  done: boolean;
  /** The ERP address, mapping and scope the pass reads with: resumed only while they are unchanged. */
  readsWith?: string;
}

export class SyncBusyError extends Error {
  constructor() {
    super('A sync is already running.');
    this.name = 'SyncBusyError';
  }
}

export interface SyncDeps {
  db: VeyraDb;
  connectionId: string;
  now: () => string;
  newId: () => string;
  /** Writes an audit event (no invoice) inside the given transaction. */
  audit: (
    tx: VeyraDb,
    event: string,
    detail: Record<string, unknown>,
    userId: string | null,
  ) => Promise<void>;
  /** Share of unreadable records above which a record type's pass is not trusted. */
  invalidThreshold?: number;
  /** A running sync whose heartbeat is older than this is considered interrupted. */
  leaseMs?: number;
  /** Safety stop for a paging loop that never ends. */
  maxPages?: number;
}

export interface SyncResult {
  runId: string;
  status: RunStatus;
  counts: Partial<Record<Entity, EntityCounts>>;
  errorCode: string | null;
  errorMessage: string | null;
}

const emptyCounts = (): EntityCounts => ({
  received: 0,
  mapped: 0,
  changed: 0,
  unchanged: 0,
  invalid: 0,
  outOfScope: 0,
  missing: 0,
  pages: 0,
  status: 'pending',
});

const MAX_ISSUES_PER_ENTITY = 200;

export class ErpSync {
  readonly #d: Required<SyncDeps>;

  constructor(deps: SyncDeps) {
    this.#d = { invalidThreshold: 0.05, leaseMs: 5 * 60_000, maxPages: 10_000, ...deps };
  }

  /** Closes a lease whose heartbeat stopped (a crashed or restarted process). */
  async closeStaleLease(): Promise<void> {
    const d = this.#d;
    const cutoff = new Date(Date.parse(d.now()) - d.leaseMs).toISOString();
    await d.db
      .update(t.erpSyncRuns)
      .set({
        status: 'interrupted',
        finishedAt: d.now(),
        errorCode: 'INTERRUPTED',
        errorMessage:
          'The sync stopped before it finished. The next sync continues from where it stopped.',
      })
      .where(
        and(
          eq(t.erpSyncRuns.connectionId, d.connectionId),
          eq(t.erpSyncRuns.status, 'running'),
          sql`${t.erpSyncRuns.heartbeatAt} < ${cutoff}`,
        ),
      );
  }

  async run(
    source: GenericApiSource,
    trigger: SyncTrigger,
    userId: string | null,
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    const d = this.#d;
    await this.closeStaleLease();
    const resumeFrom = await this.#resumable();
    const runId = d.newId();
    const started = d.now();
    const entities = ENTITIES.filter((e) => source.profile.entities[e]);
    const counts: Partial<Record<Entity, EntityCounts>> = {};
    for (const e of entities) counts[e] = emptyCounts();
    const checkpoint: Partial<Record<Entity, Checkpoint>> = {};

    try {
      await d.db.transaction(async (tx) => {
        await tx.insert(t.erpSyncRuns).values({
          id: runId,
          connectionId: d.connectionId,
          trigger,
          status: 'running',
          startedAt: started,
          heartbeatAt: started,
          startedByUserId: userId,
          countsJson: JSON.stringify(counts),
          checkpointJson: '{}',
        });
        await d.audit(tx, 'erp.sync_started', { runId, trigger }, userId);
      });
    } catch (e) {
      if (
        ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) ===
        '23505'
      )
        throw new SyncBusyError();
      throw e;
    }

    let fatal: ErpConnectorError | null = null;
    for (const entity of entities) {
      const c = counts[entity] as EntityCounts;
      const state = await this.#state(entity);
      const prev = resumeFrom?.[entity];
      const readsWith = `${source.profile.baseUrl}|${mappingHash(
        source.profile.entities[entity] as never,
        source.profile.scope,
      )}`;
      const cp: Checkpoint =
        prev && !prev.done && prev.readsWith === readsWith
          ? prev
          : {
              passId: runId,
              passStartedAt: started,
              // Incremental only after a complete pass: the first pass reads everything.
              since: source.incremental(entity) && state?.watermark ? state.watermark : null,
              cursor: null,
              done: false,
              readsWith,
            };
      checkpoint[entity] = cp;
      try {
        await this.#syncEntity(source, entity, cp, c, runId, checkpoint, counts, signal);
      } catch (e) {
        if (e instanceof ResponseShapeError) {
          c.status = 'shape_changed';
          await this.#issues(runId, entity, [
            { erpId: null, kind: 'shape_changed', detail: [e.problem] },
          ]);
          continue;
        }
        c.status = 'failed';
        fatal = e instanceof ErpConnectorError ? e : new ErpUnavailableError({ cause: e });
        break;
      }
    }

    const status: RunStatus = fatal
      ? 'failed'
      : entities.every((e) => counts[e]?.status === 'complete')
        ? 'succeeded'
        : 'partial';
    const errorCode = fatal ? `ERP_${fatal.code}` : null;
    const errorMessage = fatal
      ? fatal instanceof ErpAuthenticationError
        ? 'Your ERP refused the login. Check the credentials and try again.'
        : fatal.userMessage
      : status === 'partial'
        ? 'Some record types could not be read completely. See the issues below.'
        : null;
    await d.db.transaction(async (tx) => {
      await tx
        .update(t.erpSyncRuns)
        .set({
          status,
          finishedAt: d.now(),
          heartbeatAt: d.now(),
          countsJson: JSON.stringify(counts),
          checkpointJson: JSON.stringify(checkpoint),
          errorCode,
          errorMessage,
        })
        .where(eq(t.erpSyncRuns.id, runId));
      // Counts and codes only: never a value from the ERP.
      await d.audit(
        tx,
        status === 'failed' ? 'erp.sync_failed' : 'erp.sync_finished',
        { runId, status, errorCode, counts },
        userId,
      );
    });
    return { runId, status, counts, errorCode, errorMessage };
  }

  /** The checkpoint of the last run, when it stopped part-way (failed or interrupted). */
  async #resumable(): Promise<Partial<Record<Entity, Checkpoint>> | null> {
    const d = this.#d;
    const [last] = await d.db
      .select()
      .from(t.erpSyncRuns)
      .where(
        and(eq(t.erpSyncRuns.connectionId, d.connectionId), ne(t.erpSyncRuns.status, 'running')),
      )
      .orderBy(desc(t.erpSyncRuns.seq))
      .limit(1);
    if (!last || (last.status !== 'failed' && last.status !== 'interrupted')) return null;
    try {
      return JSON.parse(last.checkpointJson) as Partial<Record<Entity, Checkpoint>>;
    } catch {
      return null;
    }
  }

  async #state(entity: Entity) {
    const d = this.#d;
    const [row] = await d.db
      .select()
      .from(t.erpSyncState)
      .where(
        and(eq(t.erpSyncState.connectionId, d.connectionId), eq(t.erpSyncState.entity, entity)),
      );
    return row ?? null;
  }

  async #syncEntity(
    source: GenericApiSource,
    entity: Entity,
    cp: Checkpoint,
    c: EntityCounts,
    runId: string,
    checkpoint: Partial<Record<Entity, Checkpoint>>,
    counts: Partial<Record<Entity, EntityCounts>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const d = this.#d;
    let issues = 0;
    for (;;) {
      if (c.pages >= d.maxPages) throw new ResponseShapeError(entity, 'bad_next_link');
      const page = await source.fetchPage(entity, { cursor: cp.cursor, since: cp.since }, signal);
      c.pages++;
      c.received += page.received;
      const mapped: MappedRecord[] = [];
      const invalid: { erpId: string | null; kind: 'invalid'; detail: string[] }[] = [];
      for (const r of page.results) {
        if (r.ok === true) mapped.push(r.record);
        else if (r.ok === false)
          invalid.push({ erpId: r.invalid.erpId, kind: 'invalid', detail: r.invalid.fields });
        else c.outOfScope++;
      }
      c.invalid += invalid.length;
      const now = d.now();
      await d.db.transaction(async (tx) => {
        for (const rec of mapped) {
          const key = and(
            eq(t.erpSyncRecords.connectionId, d.connectionId),
            eq(t.erpSyncRecords.entity, entity),
            eq(t.erpSyncRecords.company, rec.company ?? ''),
            eq(t.erpSyncRecords.outlet, rec.outlet ?? ''),
            eq(t.erpSyncRecords.erpId, rec.erpId),
          );
          const [existing] = await tx
            .select({ rawHash: t.erpSyncRecords.rawHash })
            .from(t.erpSyncRecords)
            .where(key);
          if (!existing) {
            await tx.insert(t.erpSyncRecords).values({
              connectionId: d.connectionId,
              entity,
              erpId: rec.erpId,
              company: rec.company ?? '',
              outlet: rec.outlet ?? '',
              docJson: JSON.stringify(rec.doc),
              rawHash: rec.rawHash,
              sourceUpdatedAt: rec.sourceUpdatedAt,
              firstSeenAt: now,
              lastSeenAt: now,
              lastChangedRunId: runId,
              lastSeenRunId: cp.passId,
            });
            c.changed++;
          } else if (existing.rawHash !== rec.rawHash) {
            await tx
              .update(t.erpSyncRecords)
              .set({
                docJson: JSON.stringify(rec.doc),
                rawHash: rec.rawHash,
                sourceUpdatedAt: rec.sourceUpdatedAt,
                lastSeenAt: now,
                lastChangedRunId: runId,
                lastSeenRunId: cp.passId,
                missingSince: null,
              })
              .where(key);
            c.changed++;
          } else {
            // Unchanged: only that it was seen in this pass (and is no longer missing, if it was).
            await tx
              .update(t.erpSyncRecords)
              .set({ lastSeenAt: now, lastSeenRunId: cp.passId, missingSince: null })
              .where(key);
            c.unchanged++;
          }
          c.mapped++;
        }
        cp.cursor = page.next;
        cp.done = page.next === null;
        await tx
          .update(t.erpSyncRuns)
          .set({
            heartbeatAt: now,
            countsJson: JSON.stringify(counts),
            checkpointJson: JSON.stringify(checkpoint),
          })
          .where(eq(t.erpSyncRuns.id, runId));
      });
      if (invalid.length > 0 && issues < MAX_ISSUES_PER_ENTITY) {
        const shown = invalid.slice(0, MAX_ISSUES_PER_ENTITY - issues);
        issues += shown.length;
        await this.#issues(runId, entity, shown);
      }
      if (page.next === null) break;
    }

    // The pass read every page. Trust it only if few enough records were unreadable.
    const tooMany = c.received > 0 && c.invalid / c.received > d.invalidThreshold;
    if (tooMany) {
      c.status = 'untrusted';
      return;
    }
    await d.db.transaction(async (tx) => {
      if (cp.since === null) {
        // A full pass: records not seen in it are no longer in the ERP.
        const missing = await tx
          .update(t.erpSyncRecords)
          .set({ missingSince: d.now() })
          .where(
            and(
              eq(t.erpSyncRecords.connectionId, d.connectionId),
              eq(t.erpSyncRecords.entity, entity),
              ne(t.erpSyncRecords.lastSeenRunId, cp.passId),
              isNull(t.erpSyncRecords.missingSince),
            ),
          )
          .returning({ erpId: t.erpSyncRecords.erpId });
        c.missing = missing.length;
      }
      await tx
        .insert(t.erpSyncState)
        .values({
          connectionId: d.connectionId,
          entity,
          watermark: cp.passStartedAt,
          lastCompleteAt: d.now(),
          lastCompleteRunId: runId,
        })
        .onConflictDoUpdate({
          target: [t.erpSyncState.connectionId, t.erpSyncState.entity],
          set: { watermark: cp.passStartedAt, lastCompleteAt: d.now(), lastCompleteRunId: runId },
        });
    });
    c.status = 'complete';
  }

  async #issues(
    runId: string,
    entity: Entity,
    issues: { erpId: string | null; kind: 'invalid' | 'shape_changed'; detail: string[] }[],
  ): Promise<void> {
    if (issues.length === 0) return;
    const d = this.#d;
    await d.db.insert(t.erpSyncIssues).values(
      issues.map((i) => ({
        id: d.newId(),
        connectionId: d.connectionId,
        runId,
        entity,
        erpId: i.erpId,
        kind: i.kind,
        detailJson: JSON.stringify(i.detail),
        createdAt: d.now(),
      })),
    );
  }
}
