import { isErpConnectorError } from '@veyra/erp-connector';
import { CrashSignal } from './commit';
import type { Veyra } from './veyra';

const MAX_ATTEMPTS = 5;
/** How often an unresolved ERP write is reconciled after the first attempts (not aggressive). */
const RECONCILE_EVERY_MS = 60_000;

/**
 * In-process job runner over the SQLite `jobs` table. One loop, one job at a time, so commits are
 * serialised (commit concurrency 1). No Redis, no queue server.
 *
 * Retry semantics (ARCHITECTURE §17): only retryable ERP errors (UNAVAILABLE: unreachable,
 * network, timeout) are retried, with a deterministic backoff (1 s, 2 s, 3 s, 4 s), always with
 * the same idempotency keys. After that:
 * - an invoice with an ERP write of unknown outcome is NOT failed: it stays in COMMITTING (never
 *   shown as ready) and is reconciled once a minute until the ERP answers;
 * - anything else fails the invoice visibly, with a safe reason; it can be reprocessed.
 * Non-retryable errors (validation, conflict, not found, authentication, unsupported,
 * configuration) fail at once.
 */
export class JobRunner {
  #timer: NodeJS.Timeout | null = null;
  #busy = false;

  constructor(readonly veyra: Veyra) {}

  /** Runs one job. Returns false when nothing is ready. */
  async step(): Promise<boolean> {
    const job = this.veyra.claimJob();
    if (!job) return false;
    try {
      if (job.type === 'pipeline') await this.veyra.runPipeline(job.invoiceId);
      else await this.veyra.runCommit(job.invoiceId);
      this.veyra.finishJob(job.id, { status: 'succeeded' });
    } catch (error) {
      if (error instanceof CrashSignal) throw error; // the "process" died: leave the job running
      const safe = isErpConnectorError(error)
        ? `${error.code}: ${error.userMessage}`
        : error instanceof Error
          ? error.message
          : String(error);
      if (isErpConnectorError(error) && error.retryable) {
        if (job.attempts < MAX_ATTEMPTS) {
          this.veyra.finishJob(job.id, {
            status: 'retry',
            error: safe,
            delayMs: job.attempts * 1000,
          });
          return true;
        }
        if (this.veyra.hasUnresolvedErpWrite(job.invoiceId)) {
          this.veyra.finishJob(job.id, {
            status: 'retry',
            error: safe,
            delayMs: RECONCILE_EVERY_MS,
          });
          return true;
        }
      }
      this.veyra.finishJob(job.id, { status: 'failed', error: safe });
      this.veyra.fail(job.invoiceId, error);
    }
    return true;
  }

  /** Runs every ready job, including ones queued by earlier jobs. */
  async drain(): Promise<void> {
    while (await this.step()) {
      // keep going
    }
  }

  /** Starts the background loop (after re-queuing jobs a previous process left running). */
  start(intervalMs = 250): void {
    this.veyra.recoverJobs();
    this.veyra.onEnqueue = () => this.kick();
    this.#timer = setInterval(() => this.kick(), intervalMs);
    this.kick();
  }

  kick(): void {
    if (this.#busy) return;
    this.#busy = true;
    setImmediate(() => {
      this.drain()
        .catch((error: unknown) => console.error('job runner:', error))
        .finally(() => {
          this.#busy = false;
        });
    });
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
