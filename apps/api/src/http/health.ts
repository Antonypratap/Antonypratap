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
}

/** A worker loop that has not ticked for this long is considered stuck. */
const WORKER_STALE_MS = 30_000;

export function readinessCheck(deps: {
  veyra: Veyra;
  storage: DocumentStorage;
  runner: JobRunner;
  /** A round trip to PostgreSQL (no connection details are ever reported). */
  pingDatabase: () => Promise<void>;
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
    };
  };
}
