import { isErpConnectorError } from '@veyra/erp-connector';
import { CrashSignal } from './commit';
import { isInternalError, isRetryable, safeErrorCode } from './retry';
import type { Veyra } from './veyra';

const MAX_ATTEMPTS = 5;
/** How often an unresolved ERP write is reconciled after the first attempts (not aggressive). */
const RECONCILE_EVERY_MS = 60_000;
/** How often the loop looks for jobs whose worker disappeared. */
const LEASE_SWEEP_MS = 30_000;

/** The part of a structured logger the runner uses (pino-compatible). */
export interface JobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
const silent: JobLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface JobRunnerOptions {
  logger?: JobLogger;
  /** A claimed job not heard from for this long is treated as abandoned and re-queued. */
  leaseMs?: number;
}

/**
 * In-process job runner over the `jobs` table. One loop, one job at a time, so commits are
 * serialised (commit concurrency 1). No Redis, no queue server.
 *
 * Job lifecycle: queued → running → succeeded | failed, or back to queued for a retry.
 *
 * Retry semantics (ARCHITECTURE §17, §18): only temporary failures are retried (ERP unavailable,
 * storage unavailable, database busy), with a deterministic backoff (1 s, 2 s, 3 s, 4 s) and, for
 * ERP writes, always with the same idempotency keys. After that:
 * - an invoice with an ERP write of unknown outcome is NOT failed: it stays in COMMITTING (never
 *   shown as ready) and is reconciled once a minute until the ERP answers;
 * - anything else fails the invoice visibly, with a safe reason; it can be reprocessed.
 * Everything else (invalid documents, validation, authentication, configuration, unsupported)
 * fails at once.
 *
 * Leases (Phase 6): a running job's `locked_at` is renewed while it runs. A job whose lease
 * expired belongs to a worker that disappeared; it is queued again (or failed, once it has used
 * its attempts), so no job stays `running` forever.
 */
export class JobRunner {
  #timer: NodeJS.Timeout | null = null;
  #sweeper: NodeJS.Timeout | null = null;
  #busy = false;
  #stopping = false;
  #current: { jobId: string; done: Promise<unknown> } | null = null;
  #lastTick: number | null = null;
  readonly #log: JobLogger;
  readonly leaseMs: number;

  constructor(
    readonly veyra: Veyra,
    options: JobRunnerOptions = {},
  ) {
    this.#log = options.logger ?? silent;
    this.leaseMs = options.leaseMs ?? 15 * 60 * 1000;
  }

  /** Runs one job. Returns false when nothing is ready. */
  async step(): Promise<boolean> {
    if (this.#stopping) return false;
    const job = this.veyra.claimJob();
    if (!job) return false;
    const started = Date.now();
    const context = {
      jobId: job.id,
      invoiceId: job.invoiceId,
      type: job.type,
      attempt: job.attempts,
    };
    const heartbeat = setInterval(
      () => this.veyra.touchJob(job.id),
      Math.max(1000, Math.floor(this.leaseMs / 3)),
    );
    const work = (async () => {
      if (job.type === 'pipeline') await this.veyra.runPipeline(job.invoiceId);
      else await this.veyra.runCommit(job.invoiceId);
    })();
    this.#current = { jobId: job.id, done: work.catch(() => undefined) };
    try {
      await work;
      this.veyra.finishJob(job.id, { status: 'succeeded' });
      this.#log.info({ ...context, durationMs: Date.now() - started }, 'job succeeded');
    } catch (error) {
      if (error instanceof CrashSignal) throw error; // the "process" died: leave the job running
      this.#handleFailure(job, error, context);
    } finally {
      clearInterval(heartbeat);
      this.#current = null;
    }
    return true;
  }

  #handleFailure(
    job: { id: string; invoiceId: string; attempts: number },
    error: unknown,
    context: object,
  ): void {
    const code = safeErrorCode(error);
    const safe = isErpConnectorError(error)
      ? `${error.code}: ${error.userMessage}`
      : isInternalError(error)
        ? code
        : error instanceof Error
          ? error.message
          : String(error);
    if (isRetryable(error)) {
      if (job.attempts < MAX_ATTEMPTS) {
        const delayMs = job.attempts * 1000;
        this.veyra.finishJob(job.id, { status: 'retry', error: safe, delayMs });
        this.#log.warn({ ...context, errorCode: code, delayMs }, 'job will be retried');
        return;
      }
      if (this.veyra.hasUnresolvedErpWrite(job.invoiceId)) {
        this.veyra.finishJob(job.id, {
          status: 'retry',
          error: safe,
          delayMs: RECONCILE_EVERY_MS,
        });
        this.#log.warn({ ...context, errorCode: code }, 'ERP write unresolved; reconciling');
        return;
      }
    }
    this.veyra.finishJob(job.id, { status: 'failed', error: safe });
    // Internal errors are logged in full here (server-side only); people see a generic reason.
    this.#log.error(
      { ...context, errorCode: code, ...(isInternalError(error) ? { err: error } : {}) },
      'job failed',
    );
    this.veyra.fail(job.invoiceId, error);
  }

  /** Re-queues (or, when out of attempts, fails) jobs whose worker disappeared. */
  recoverExpired(): number {
    const expired = this.veyra.expiredJobs(this.leaseMs);
    for (const job of expired) {
      if (job.id === this.#current?.jobId) continue;
      if (job.attempts >= MAX_ATTEMPTS && !this.veyra.hasUnresolvedErpWrite(job.invoiceId)) {
        const reason = 'Processing stopped repeatedly before it could finish.';
        this.veyra.finishJob(job.id, { status: 'failed', error: 'WORKER_LOST' });
        this.veyra.fail(job.invoiceId, new Error(reason));
        this.#log.error({ jobId: job.id, invoiceId: job.invoiceId }, 'abandoned job failed');
      } else {
        this.veyra.releaseJob(job.id);
        this.#log.warn({ jobId: job.id, invoiceId: job.invoiceId }, 'abandoned job re-queued');
      }
    }
    return expired.length;
  }

  /** Runs every ready job, including ones queued by earlier jobs. */
  async drain(): Promise<void> {
    while (await this.step()) {
      // keep going
    }
  }

  /** Starts the background loop (after re-queuing jobs a previous process left running). */
  start(intervalMs = 250): void {
    this.#stopping = false;
    const recovered = this.veyra.recoverJobs();
    if (recovered)
      this.#log.warn({ recovered }, 'jobs left running by a previous process re-queued');
    this.veyra.onEnqueue = () => this.kick();
    this.#timer = setInterval(() => {
      this.#lastTick = Date.now();
      this.kick();
    }, intervalMs);
    this.#sweeper = setInterval(() => this.recoverExpired(), LEASE_SWEEP_MS);
    this.#lastTick = Date.now();
    this.kick();
  }

  kick(): void {
    if (this.#busy || this.#stopping) return;
    this.#busy = true;
    setImmediate(() => {
      this.drain()
        .catch((error: unknown) =>
          this.#log.error({ err: error, errorCode: safeErrorCode(error) }, 'job runner error'),
        )
        .finally(() => {
          this.#busy = false;
        });
    });
  }

  /** Worker liveness for readiness: running, and its loop ticked recently. */
  health(): { running: boolean; lastTickAgoMs: number | null; busy: boolean } {
    return {
      running: this.#timer !== null,
      lastTickAgoMs: this.#lastTick === null ? null : Date.now() - this.#lastTick,
      busy: this.#current !== null,
    };
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#timer = null;
    this.#sweeper = null;
  }

  /**
   * Graceful stop: takes no new job, lets the current one finish for up to `graceMs`, and
   * otherwise puts it back in the queue so the next worker picks it up (never left `running`).
   */
  async shutdown(graceMs: number): Promise<void> {
    this.#stopping = true;
    this.stop();
    const current = this.#current;
    if (!current) return;
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      current.done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) {
      this.veyra.releaseJob(current.jobId);
      this.#log.warn({ jobId: current.jobId }, 'job released at shutdown');
    }
  }
}
