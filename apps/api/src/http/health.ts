import { describeConnection, type ErpConnectionStatus } from '@veyra/erp-connector';
import type { Environment } from '../config';
import type { DocumentStorage } from '../storage';
import type { JobRunner } from '../workflow/runner';
import type { Veyra } from '../workflow/veyra';

type Check = { status: 'ok' | 'fail'; code?: string };

/**
 * Readiness (Phase 6): can this instance serve traffic and do its work? Required: the database,
 * document storage and a live worker loop. The ERP is reported but does not make the instance
 * unready: reads and commits wait and retry while it is unavailable, and the UI stays usable.
 * Only statuses, codes and counts: never hosts, paths, connection strings or errors.
 */
export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  environment: Environment;
  checks: {
    database: Check;
    storage: Check;
    worker: Check & { lastTickAgoMs: number | null };
    erp: { status: ErpConnectionStatus };
  };
  jobs: {
    queued: number;
    running: number;
    expired: number;
    failedLast24h: number;
    oldestQueuedAgeMs: number | null;
  } | null;
  /**
   * Recent originals whose stored file is missing: anything above 0 means document storage is
   * losing files (e.g. the data directory is not a persistent volume). Reported, not "not ready":
   * missing files cannot come back by restarting.
   */
  documents: { checked: number; missing: number } | null;
  /** Connection pool counts (null with the embedded development database). */
  pool: { total: number; idle: number; waiting: number; max: number } | null;
}

/** A worker loop that has not ticked for this long is considered stuck. */
const WORKER_STALE_MS = 30_000;

export function readinessCheck(deps: {
  veyra: Veyra;
  storage: DocumentStorage;
  runner: JobRunner;
  /** A round trip to PostgreSQL (no connection details are ever reported). */
  pingDatabase: () => Promise<void>;
  /** Connection pool counts, when there is a pool (Phase 7). */
  poolStats?: () => { total: number; idle: number; waiting: number; max: number } | null;
  environment: Environment;
  /** Whether this process runs the worker (false for an API-only instance). */
  expectWorker: boolean;
}): () => Promise<ReadinessReport> {
  return async () => {
    const database: Check = await deps
      .pingDatabase()
      .then(() => ({ status: 'ok' as const }))
      .catch(() => ({ status: 'fail' as const, code: 'DATABASE_UNAVAILABLE' }));
    const storage: Check = await deps.storage
      .check()
      .then(() => ({ status: 'ok' as const }))
      .catch((e: unknown) => ({
        status: 'fail' as const,
        code: (e as { code?: string }).code ?? 'STORAGE_UNAVAILABLE',
      }));
    const w = deps.runner.health();
    const workerOk =
      !deps.expectWorker ||
      (w.running && w.lastTickAgoMs !== null && w.lastTickAgoMs < WORKER_STALE_MS);
    const erp = await describeConnection(deps.veyra.erp).then(
      (c) => ({ status: c.status }),
      () => ({ status: 'UNKNOWN' as const }),
    );
    let jobs: ReadinessReport['jobs'] = null;
    if (database.status === 'ok') {
      try {
        jobs = await deps.veyra.jobStats(deps.runner.leaseMs);
      } catch {
        jobs = null;
      }
    }
    const documents =
      database.status === 'ok' && storage.status === 'ok'
        ? await deps.veyra.missingDocumentFiles().catch(() => null)
        : null;
    const ready = database.status === 'ok' && storage.status === 'ok' && workerOk;
    return {
      status: ready ? 'ready' : 'not_ready',
      environment: deps.environment,
      checks: {
        database,
        storage,
        worker: {
          status: workerOk ? 'ok' : 'fail',
          ...(workerOk ? {} : { code: 'WORKER_NOT_RUNNING' }),
          lastTickAgoMs: w.lastTickAgoMs,
        },
        erp,
      },
      jobs,
      documents,
      // Counts only (Phase 7): connections open, idle, and requests waiting for one.
      pool: deps.poolStats?.() ?? null,
    };
  };
}

/** What an anonymous probe of a deployed instance sees: statuses and failure codes only. */
export function publicReadiness(report: ReadinessReport) {
  const { database, storage, worker } = report.checks;
  const only = (c: Check) => (c.code ? { status: c.status, code: c.code } : { status: c.status });
  return {
    status: report.status,
    checks: { database: only(database), storage: only(storage), worker: only(worker) },
  };
}
