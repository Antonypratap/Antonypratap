import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { guardCapabilities, type ErpConnector } from '@veyra/erp-connector';
import type { Extractor } from '@veyra/extractor';
import { openVeyraDb, type VeyraDatabase } from '../db/open';
import { Presenter } from '../http/present';
import { BusinessImports } from '../imports/service';
import { LocalDocumentStorage } from '../storage';
import { JobRunner } from '../workflow/runner';
import { DEFAULT_SETTINGS, Veyra } from '../workflow/veyra';

/**
 * A challenge's isolated workspace: its own embedded PostgreSQL (PGlite), its own records store
 * (the ERP connector the checks read: suppliers, items, orders, receipts the prospect provided)
 * and its own document folder, under `<root>/<challengeId>/`. The product's own Veyra core, job
 * runner, presenter and import service run on it unchanged, so a challenge's invoices go through
 * exactly the pipeline a customer's do, and one company's invoices, duplicates and records can
 * never meet another's: they are in different databases.
 *
 * Workspaces are opened on demand and closed when idle (each embedded database holds memory);
 * an open workspace with work queued stays open until the work is done.
 */
/**
 * A workspace's own records store: an ERP connector over a file in the workspace, which starts
 * knowing only the buying company. Provided by the composition root (app.ts), the only place that
 * knows which ERP implementation is used.
 */
export interface WorkspaceErp {
  readonly connector: ErpConnector;
  /** The buying company, once its owner confirms its GSTIN. */
  setCompany(c: { name: string; gstin: string }): void;
  close(): void;
}
export type WorkspaceErpFactory = (filename: string, fresh: boolean) => WorkspaceErp;

export interface ChallengeWorkspace {
  readonly id: string;
  readonly veyra: Veyra;
  readonly erp: WorkspaceErp;
  readonly presenter: Presenter;
  readonly imports: BusinessImports;
  readonly runner: JobRunner;
  /** While true, invoices are read and then wait before the checks (records still coming). */
  held: boolean;
  lastUsedAt: number;
}

export interface WorkspaceOptions {
  /** Folder holding every workspace (each in its own subfolder). */
  root: string;
  /** The real document reader (never the demo's fixture reader). */
  extractor: Extractor;
  /** Opens a workspace's records store. */
  erp: WorkspaceErpFactory;
  clock?: () => Date;
  maxUploadBytes?: number;
  /** Close a workspace unused for this long (and with no work queued). */
  idleMs?: number;
  /** At most this many open at once; the least recently used idle one closes first. */
  maxOpen?: number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

interface Open {
  ws: ChallengeWorkspace;
  database: VeyraDatabase;
}

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class ChallengeWorkspaces {
  readonly #o: Required<Omit<WorkspaceOptions, 'log' | 'maxUploadBytes'>> &
    Pick<WorkspaceOptions, 'log' | 'maxUploadBytes'>;
  readonly #open = new Map<string, Promise<Open>>();
  #sweeper: NodeJS.Timeout | null = null;

  constructor(options: WorkspaceOptions) {
    this.#o = {
      clock: () => new Date(),
      idleMs: 10 * 60_000,
      maxOpen: 4,
      ...options,
      root: resolve(options.root),
    };
    mkdirSync(this.#o.root, { recursive: true });
  }

  /** The folder of one workspace (ids are ULIDs: never a path from outside). */
  dirOf(id: string): string {
    if (!ID.test(id)) throw new Error('invalid challenge id');
    return join(this.#o.root, id);
  }

  exists(id: string): boolean {
    return existsSync(this.dirOf(id));
  }

  /**
   * Opens (creating on first use) the workspace of a challenge. `company` names the buying
   * company; `held` is whether the checks wait (the challenge is still collecting).
   */
  async open(id: string, init: { company: string; held: boolean }): Promise<ChallengeWorkspace> {
    let pending = this.#open.get(id);
    if (!pending) {
      pending = this.#create(id, init);
      this.#open.set(id, pending);
      pending.catch(() => this.#open.delete(id));
      void this.#enforceMax(id);
    }
    const { ws } = await pending;
    ws.lastUsedAt = Date.now();
    return ws;
  }

  async #create(id: string, init: { company: string; held: boolean }): Promise<Open> {
    const dir = this.dirOf(id);
    const fresh = !existsSync(join(dir, 'erp.db'));
    mkdirSync(dir, { recursive: true });
    const database = await openVeyraDb({ url: null, pgliteDir: join(dir, 'db'), migrate: true });
    // A new workspace knows only the buying company; everything else the prospect provides.
    const erp = this.#o.erp(join(dir, 'erp.db'), fresh);
    const ws = {
      id,
      held: init.held,
      lastUsedAt: Date.now(),
    } as ChallengeWorkspace;
    const veyra = new Veyra({
      db: database.db,
      erp: guardCapabilities(erp.connector),
      extractor: this.#o.extractor,
      storage: new LocalDocumentStorage(join(dir, 'uploads')),
      initialSettings: DEFAULT_SETTINGS,
      clock: this.#o.clock,
      organizationName: init.company,
      readAhead: 3,
      holdChecks: () => ws.held,
      ...(this.#o.maxUploadBytes ? { maxUploadBytes: this.#o.maxUploadBytes } : {}),
      ...(this.#o.log ? { log: this.#o.log } : {}),
    });
    await veyra.init();
    const runner = new JobRunner(veyra);
    runner.start();
    Object.assign(ws, {
      veyra,
      erp,
      runner,
      presenter: new Presenter(veyra),
      imports: new BusinessImports(veyra),
    });
    return { ws, database };
  }

  /** Closes an open workspace (its runner, database and records store); data stays on disk. */
  async close(id: string, graceMs = 5_000): Promise<void> {
    const pending = this.#open.get(id);
    if (!pending) return;
    this.#open.delete(id);
    const { ws, database } = await pending.catch(() => ({ ws: null, database: null }));
    if (!ws || !database) return;
    await ws.runner.shutdown(graceMs);
    ws.veyra.clearReadAhead();
    await database.close();
    ws.erp.close();
  }

  /** Deletes a workspace entirely: documents, readings, records (retention, or on request). */
  async remove(id: string): Promise<void> {
    await this.close(id, 0);
    rmSync(this.dirOf(id), { recursive: true, force: true });
  }

  /** Whether the workspace has work queued or running (then it is never closed as idle). */
  async #busy(ws: ChallengeWorkspace): Promise<boolean> {
    return (await ws.veyra.pendingJobs()) > 0;
  }

  async #enforceMax(keep: string): Promise<void> {
    if (this.#open.size <= this.#o.maxOpen) return;
    const candidates: { id: string; at: number }[] = [];
    for (const [id, p] of this.#open) {
      if (id === keep) continue;
      const { ws } = await p.catch(() => ({ ws: null }));
      if (ws && !(await this.#busy(ws))) candidates.push({ id, at: ws.lastUsedAt });
    }
    candidates.sort((a, b) => a.at - b.at);
    for (const c of candidates.slice(0, this.#open.size - this.#o.maxOpen)) await this.close(c.id);
  }

  /** Closes idle workspaces. */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, p] of [...this.#open]) {
      const { ws } = await p.catch(() => ({ ws: null }));
      if (ws && now - ws.lastUsedAt > this.#o.idleMs && !(await this.#busy(ws)))
        await this.close(id);
    }
  }

  start(intervalMs = 60_000): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => void this.sweep().catch(() => undefined), intervalMs);
    this.#sweeper.unref();
  }

  async shutdown(graceMs = 5_000): Promise<void> {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
    for (const id of [...this.#open.keys()]) await this.close(id, graceMs);
  }

  openIds(): string[] {
    return [...this.#open.keys()];
  }
}
