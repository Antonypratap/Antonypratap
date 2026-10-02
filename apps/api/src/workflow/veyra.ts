import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { and, asc, desc, eq, inArray, lte, max, ne, notInArray, sql } from 'drizzle-orm';
import {
  ExtractionResultSchema,
  LINE_FIELD_KEYS,
  MAX_UPLOAD_BYTES,
  headerPath,
  linePath,
  type AnswerEffect,
  type ExtractionResult,
  type FieldPath,
  type FieldSource,
  type HeaderFieldKey,
  type InvoiceState,
  type LineFieldKey,
  type QuestionCode,
} from '@veyra/shared';
import { isErpConnectorError, type ErpConnector } from '@veyra/erp-connector';
import { can, type Permission } from '@veyra/shared';
import { checkImageSize, imageSize, sniffDocument, type Extractor } from '@veyra/extractor';
import type { VeyraDb, VeyraTx } from '../db/open';
import * as t from '../db/schema';
import { leaf, stage } from '../perf/timing';
import { ulid } from '../ids';
import type { DocumentStorage } from '../storage';
import { Entitlements, INITIAL_PLAN, LimitReachedError } from '../commercial/entitlements';
import { monthOf } from '../commercial/usage';
import { INTERNAL_FAILURE_REASON, isInternalError, isRetryable } from './retry';
import { readField, type JsonValue, type StoredField } from '../engine/fields';
import { runEngine } from '../engine/run';
import { mdField } from '../engine/questions';
import type {
  AnsweredDecision,
  CommitPlan,
  EngineOutput,
  EngineSettings,
  InputSpec,
  QuestionDraft,
} from '../engine/types';
import { assertTransition } from './state-machine';
import { parseAnswerInput } from './answers';
import { executeCommit, type CommitHooks } from './commit';
import {
  ReceiptFileSchema,
  receiptComparison,
  invoiceNoKey,
  normalizeReceipt,
  pickRecord,
  toPaise,
  type InvoiceSide,
  type ReceiptRecord,
} from './erp-receipts';

type Db = VeyraDb | VeyraTx;

export const DEMO_USER = {
  id: '00000000000000000000000001',
  name: 'Demo Approver',
  email: 'approver@veyra.local',
} as const;

/** A stored extracted field as the engine reads it. */
export function storedField(r: typeof t.extractedFields.$inferSelect): StoredField {
  return {
    path: r.path as FieldPath,
    value: JSON.parse(r.valueJson) as JsonValue,
    confidenceBp: r.confidenceBp,
    source: r.source as FieldSource,
    evidence: r.evidenceJson ? JSON.parse(r.evidenceJson) : null,
    evidenceDetail: r.evidenceDetailJson ? JSON.parse(r.evidenceDetailJson) : null,
  };
}

/** The one organization this deployment serves (Phase 6C; see db/schema.ts `organizations`). */
export const ORGANIZATION_ID = '00000000000000000000000001';

export interface VeyraSettings extends EngineSettings {
  designatedUserId: string;
  extractorMode: string;
}

export const DEFAULT_SETTINGS: Omit<VeyraSettings, 'designatedUserId'> = {
  extractorMode: 'local_ocr',
  confidenceMinBp: 9000,
  poAutoCreateEnabled: false,
  poAutoCreateBelowPaise: 0,
};

/** DEMO.md §1.1: the demo turns automatic POs on below ₹25,000.00 (grand total incl. GST). */
export const DEMO_SETTINGS: Omit<VeyraSettings, 'designatedUserId'> = {
  extractorMode: 'demo',
  confidenceMinBp: 9000,
  poAutoCreateEnabled: true,
  poAutoCreateBelowPaise: 2_500_000,
};

const SETTING_KEYS = {
  designatedUserId: 'designated_user_id',
  extractorMode: 'extractor_mode',
  confidenceMinBp: 'extraction_confidence_min_bp',
  poAutoCreateEnabled: 'po_auto_create_enabled',
  poAutoCreateBelowPaise: 'po_auto_create_below_paise',
} as const satisfies Record<keyof VeyraSettings, string>;

export class VeyraError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'DUPLICATE_UPLOAD'
      | 'INVALID_STATE'
      | 'INVALID_INPUT'
      | 'UNSUPPORTED_FILE'
      | 'FORBIDDEN'
      | 'CONFLICT',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'VeyraError';
  }
}

export interface VeyraOptions {
  db: VeyraDb;
  erp: ErpConnector;
  extractor: Extractor;
  /** Where uploaded documents are kept (Phase 6: local folder or object storage). */
  storage: DocumentStorage;
  /** Largest accepted upload; at most MAX_UPLOAD_BYTES. */
  maxUploadBytes?: number;
  clock?: () => Date;
  initialSettings?: Omit<VeyraSettings, 'designatedUserId'>;
  commitHooks?: CommitHooks;
  /** The configured organization's name (Phase 6C). */
  organizationName?: string;
  /** Commercial entitlements (Phase 8A); one per process, shared with Veyra Operations. */
  entitlements?: Entitlements;
  /**
   * Documents read at the same time as soon as they are uploaded (0: off). Reading (the slow part,
   * an AI call or OCR) then overlaps for several invoices; checking and recording stay one at a
   * time, in the job runner.
   */
  readAhead?: number;
  /** Structured log of how each invoice was read (never document content or credentials). */
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

type Actor = { type: 'system' | 'ai' } | { type: 'user'; userId: string };

/**
 * The Veyra application core: upload, the pipeline (READ → FIND → USE → CREATE → VALIDATE → ASK),
 * answers, rejection and commit. HTTP routes are a thin layer over this class; the job runner
 * calls `runPipeline` / `runCommit`.
 */
export class Veyra {
  readonly db: VeyraDb;
  readonly erp: ErpConnector;
  readonly extractor: Extractor;
  readonly storage: DocumentStorage;
  readonly maxUploadBytes: number;
  readonly clock: () => Date;
  readonly commitHooks: CommitHooks;
  /** Called after work is queued, so a running job loop picks it up at once. */
  onEnqueue: () => void = () => undefined;
  /** Called with an internal error that failed an invoice, so it can be logged server-side. */
  onInternalError: (error: unknown, context: { invoiceId: string }) => void = () => undefined;

  constructor(options: VeyraOptions) {
    this.db = options.db;
    this.erp = options.erp;
    this.extractor = options.extractor;
    this.storage = options.storage;
    this.maxUploadBytes = Math.min(options.maxUploadBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
    this.clock = options.clock ?? (() => new Date());
    this.commitHooks = options.commitHooks ?? {};
    this.#initial = options.initialSettings ?? DEFAULT_SETTINGS;
    this.organizationName = options.organizationName ?? 'Toit';
    this.#log = options.log ?? null;
    this.#readAheadMax = options.readAhead ?? 0;
    this.entitlements = options.entitlements ?? new Entitlements(this.db, this.clock);
  }

  /** What this organization may use (Phase 8A): the one place commercial checks go through. */
  readonly entitlements: Entitlements;

  readonly organizationName: string;
  /** Every user and resource of this deployment belongs to this organization (Phase 6C). */
  readonly organizationId = ORGANIZATION_ID;

  readonly #initial: Omit<VeyraSettings, 'designatedUserId'>;
  readonly #log: VeyraOptions['log'] | null;
  readonly #readAheadMax: number;
  /** Readings started at upload, by document id, taken by the pipeline when it gets there. */
  readonly #ahead = new Map<string, Promise<unknown>>();
  #aheadRunning = 0;
  readonly #aheadWaiting: (() => void)[] = [];

  /** Starts reading a document now, alongside others (at most `readAhead` at once). */
  private readAhead(doc: { id: string; mime: string; sha256: string; storagePath: string }): void {
    if (this.#readAheadMax <= 0 || this.#ahead.has(doc.id)) return;
    const reading = (async () => {
      while (this.#aheadRunning >= this.#readAheadMax)
        await new Promise<void>((r) => this.#aheadWaiting.push(r));
      this.#aheadRunning++;
      try {
        return await this.readDocumentNow(doc);
      } finally {
        this.#aheadRunning--;
        this.#aheadWaiting.shift()?.();
      }
    })();
    reading.catch(() => undefined); // taken (and its error handled) by the pipeline
    this.#ahead.set(doc.id, reading);
  }

  /** Forgets readings started ahead (demo reset). */
  clearReadAhead(): void {
    this.#ahead.clear();
  }

  private readDocumentNow(doc: { id: string; mime: string; sha256: string; storagePath: string }) {
    // The reader gets a verified local copy of the original (object storage: a private
    // temporary file, removed as soon as the document has been read).
    return this.storage.withLocalFile(
      this.documentKey(doc),
      (filePath) =>
        this.extractor.extract({
          documentId: doc.id,
          filePath,
          mime: doc.mime,
          sha256: doc.sha256,
        }),
      { sha256: doc.sha256 },
    );
  }

  /** Creates the designated user and default settings when missing. Call once before use. */
  async init(): Promise<this> {
    await this.bootstrap(this.#initial);
    return this;
  }

  now(): string {
    return this.clock().toISOString();
  }

  /** Today in India (Asia/Kolkata), as YYYY-MM-DD. */
  today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(this.clock());
  }

  // ── Setup ────────────────────────────────────────────────────────────────

  private async bootstrap(initial: Omit<VeyraSettings, 'designatedUserId'>): Promise<void> {
    const now = this.now();
    // Idempotent under concurrency: several instances may start at once.
    await this.db.transaction(async (tx) => {
      await tx
        .insert(t.organizations)
        .values({
          id: ORGANIZATION_ID,
          name: this.organizationName,
          createdAt: now,
          // A new deployment starts on the initial plan; Veyra Operations changes it (audited).
          planKey: INITIAL_PLAN,
          planAssignedAt: now,
        })
        .onConflictDoUpdate({ target: t.organizations.id, set: { name: this.organizationName } });
      // The designated approver questions are assigned to. It has no password: it cannot sign in
      // (outside production, the demo sign-in uses it).
      await tx
        .insert(t.users)
        .values({
          ...DEMO_USER,
          active: true,
          organizationId: ORGANIZATION_ID,
          role: 'ADMIN',
          passwordHash: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      const values: VeyraSettings = { ...initial, designatedUserId: DEMO_USER.id };
      for (const [k, key] of Object.entries(SETTING_KEYS)) {
        await tx
          .insert(t.settings)
          .values({
            key,
            valueJson: JSON.stringify(values[k as keyof VeyraSettings]),
            updatedByUserId: null,
            updatedAt: now,
          })
          .onConflictDoNothing();
      }
    });
  }

  async settings(db: Db = this.db): Promise<VeyraSettings> {
    const rows = await db.select().from(t.settings);
    const get = (key: string): unknown => {
      const row = rows.find((r) => r.key === key);
      return row ? JSON.parse(row.valueJson) : undefined;
    };
    return {
      designatedUserId: String(get(SETTING_KEYS.designatedUserId)),
      extractorMode: String(get(SETTING_KEYS.extractorMode)),
      confidenceMinBp: Number(get(SETTING_KEYS.confidenceMinBp)),
      poAutoCreateEnabled: get(SETTING_KEYS.poAutoCreateEnabled) === true,
      poAutoCreateBelowPaise: Number(get(SETTING_KEYS.poAutoCreateBelowPaise)),
    };
  }

  /** V1 has exactly one designated user; every decision is theirs (no hierarchy, no roles). */
  async designatedUserId(): Promise<string> {
    return (await this.settings()).designatedUserId;
  }

  /**
   * Authorization in the application core (Phase 6C), behind the HTTP layer's checks: the acting
   * user exists, is active, belongs to this organization and has the permission. Replaces the
   * earlier "designated user only" rule, which assumed a single user.
   */
  async requireActor(userId: string, permission: Permission): Promise<void> {
    const user = (await this.db.select().from(t.users).where(eq(t.users.id, userId)).limit(1))[0];
    if (
      !user ||
      !user.active ||
      user.organizationId !== this.organizationId ||
      !can(user.role, permission)
    )
      throw new VeyraError('FORBIDDEN', 'You do not have permission to do this.');
  }

  // ── Audit and transitions ────────────────────────────────────────────────

  async audit(
    db: Db,
    invoiceId: string | null,
    actor: Actor,
    event: (typeof t.auditEvents.$inferInsert)['event'],
    detail: Record<string, JsonValue>,
    states: { from: InvoiceState; to: InvoiceState } | null = null,
  ): Promise<void> {
    await leaf('AUDIT', () => this.writeAudit(db, invoiceId, actor, event, detail, states));
  }

  private async writeAudit(
    db: Db,
    invoiceId: string | null,
    actor: Actor,
    event: (typeof t.auditEvents.$inferInsert)['event'],
    detail: Record<string, JsonValue>,
    states: { from: InvoiceState; to: InvoiceState } | null,
  ): Promise<void> {
    await db.insert(t.auditEvents).values({
      id: ulid(),
      invoiceId,
      actorType: actor.type,
      actorUserId: actor.type === 'user' ? actor.userId : null,
      event,
      fromState: states?.from ?? null,
      toState: states?.to ?? null,
      detailJson: JSON.stringify(detail),
      createdAt: this.now(),
    });
  }

  /** A legal transition, with optimistic locking and its audit row, in the caller's transaction. */
  async transition(
    db: Db,
    invoiceId: string,
    from: InvoiceState,
    to: InvoiceState,
    actor: Actor,
    patch: Partial<typeof t.invoices.$inferInsert> = {},
  ): Promise<void> {
    assertTransition(from, to);
    const updated = await db
      .update(t.invoices)
      .set({
        ...patch,
        state: to,
        stateVersion: sql`${t.invoices.stateVersion} + 1`,
        updatedAt: this.now(),
      })
      .where(and(eq(t.invoices.id, invoiceId), eq(t.invoices.state, from)))
      .returning({ id: t.invoices.id });
    if (updated.length !== 1)
      throw new VeyraError('INVALID_STATE', `invoice ${invoiceId} is no longer ${from}`);
    await this.audit(db, invoiceId, actor, 'invoice.state_changed', {}, { from, to });
  }

  /**
   * The invoice row. With `lock`, the row is locked for the rest of the caller's transaction, so
   * two workers never run the same stage of one invoice at the same time (PostgreSQL).
   */
  async invoiceRow(db: Db, invoiceId: string, lock = false) {
    const query = db.select().from(t.invoices).where(eq(t.invoices.id, invoiceId)).limit(1);
    const row = (await (lock ? query.for('update') : query))[0];
    if (!row) throw new VeyraError('NOT_FOUND', `invoice ${invoiceId} not found`);
    return row;
  }

  async enqueue(db: Db, invoiceId: string, type: 'pipeline' | 'commit'): Promise<void> {
    const pending = (
      await db
        .select()
        .from(t.jobs)
        .where(
          and(eq(t.jobs.invoiceId, invoiceId), eq(t.jobs.type, type), eq(t.jobs.status, 'queued')),
        )
        .limit(1)
    )[0];
    if (pending) return;
    const now = this.now();
    await db.insert(t.jobs).values({
      id: ulid(),
      invoiceId,
      type,
      status: 'queued',
      attempts: 0,
      runAfter: now,
      lockedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  /**
   * Stores an uploaded invoice document and queues it. The file is untrusted: its type is decided
   * by its bytes, not its name or the browser's claim. An identical file (same SHA-256) is refused.
   */
  async upload(
    file: {
      filename: string;
      bytes: Uint8Array;
    },
    /** Who uploads (recorded and authorized); absent: the designated user (demo, tests). */
    actorId?: string,
  ): Promise<{ documentId: string; invoiceId: string }> {
    return stage('UPLOAD', () => this.store(file, actorId));
  }

  private async store(
    file: { filename: string; bytes: Uint8Array },
    actorId: string | undefined,
  ): Promise<{ documentId: string; invoiceId: string }> {
    const { bytes } = file;
    if (actorId) await this.requireActor(actorId, 'documents.upload');
    if (bytes.length === 0) throw new VeyraError('UNSUPPORTED_FILE', 'The file is empty.');
    if (bytes.length > this.maxUploadBytes)
      throw new VeyraError(
        'UNSUPPORTED_FILE',
        `Files up to ${uploadLimitText(this.maxUploadBytes)} are accepted.`,
      );
    const mime = sniffDocument(bytes);
    if (!mime) throw new VeyraError('UNSUPPORTED_FILE', 'Upload a PDF, JPEG or PNG invoice.');
    checkDocumentShape(bytes, mime);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = (
      await this.db.select().from(t.documents).where(eq(t.documents.sha256, sha256)).limit(1)
    )[0];
    if (existing) {
      const inv = (
        await this.db
          .select({ id: t.invoices.id })
          .from(t.invoices)
          .where(eq(t.invoices.documentId, existing.id))
          .limit(1)
      )[0];
      throw new VeyraError('DUPLICATE_UPLOAD', 'This exact file was already uploaded.', {
        documentId: existing.id,
        invoiceId: inv?.id ?? null,
      });
    }
    // Commercial limits (Phase 8A): checked before the file is stored, and again, exactly, inside
    // the transaction that records it.
    const limits = await this.uploadLimits();
    await this.checkUploadLimits(this.db, bytes.length, limits);
    const documentId = ulid();
    const invoiceId = ulid();
    const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
    // The storage key is Veyra's own (ids only): the uploaded filename is metadata, never a path.
    const storageKey = `${documentId}.${ext}`;
    await this.storage.put(storageKey, bytes, { mime, sha256 });
    const filename = safeFilename(file.filename, ext);
    const userId = actorId ?? (await this.designatedUserId());
    const now = this.now();
    try {
      await this.db.transaction(async (tx) => {
        // Uploads are counted one at a time, so parallel uploads cannot pass a limit together.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('veyra.upload.limits'))`);
        await this.checkUploadLimits(tx as unknown as VeyraDb, bytes.length, limits);
        await tx.insert(t.documents).values({
          id: documentId,
          sha256,
          filename,
          mime,
          sizeBytes: bytes.length,
          storagePath: storageKey,
          uploadedByUserId: userId,
          uploadedAt: now,
        });
        await tx.insert(t.invoices).values({
          id: invoiceId,
          documentId,
          state: 'UPLOADED',
          stateVersion: 1,
          runNo: 0,
          createdAt: now,
          updatedAt: now,
        });
        await this.audit(tx, invoiceId, { type: 'user', userId }, 'invoice.uploaded', {
          filename,
          mime,
          sizeBytes: bytes.length,
          sha256,
        });
        await this.enqueue(tx, invoiceId, 'pipeline');
      });
    } catch (error) {
      // Not recorded (e.g. the same file uploaded at the same moment): keep no orphan document.
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
    this.onEnqueue();
    this.readAhead({ id: documentId, mime, sha256, storagePath: storageKey });
    return { documentId, invoiceId };
  }

  /**
   * The monthly invoice limit and the storage limit (Phase 8A, commercial). The invoice being
   * uploaded counts: at a limit of 2,000 the 2,000th is accepted and the 2,001st refused. Unlimited
   * skips the count entirely.
   */
  private async uploadLimits(): Promise<{ monthly: number | null; storage: number | null }> {
    const org = this.organizationId;
    const [monthly, storage] = await Promise.all([
      this.entitlements.limit(org, 'invoice.monthly_limit'),
      this.entitlements.limit(org, 'storage.max_bytes'),
    ]);
    return { monthly, storage };
  }

  private async checkUploadLimits(
    q: VeyraDb,
    adding: number,
    limits: { monthly: number | null; storage: number | null },
  ): Promise<void> {
    if (limits.monthly === null && limits.storage === null) return;
    const { from } = monthOf(this.clock());
    const [row] = await q
      .select({
        month: sql<number>`count(*) filter (where ${t.documents.uploadedAt} >= ${from}::timestamptz)::int`,
        bytes: sql<string>`coalesce(sum(${t.documents.sizeBytes}), 0)::text`,
      })
      .from(t.documents);
    if (limits.monthly !== null && (row?.month ?? 0) + 1 > limits.monthly)
      throw new LimitReachedError(
        'invoice.monthly_limit',
        'Monthly invoice processing limit reached.',
      );
    if (limits.storage !== null && Number(row?.bytes ?? 0) + adding > limits.storage)
      throw new LimitReachedError('storage.max_bytes', 'Document storage limit reached.');
  }

  /**
   * The storage key of a document. Rows written before Phase 6 hold the absolute path of a file
   * in the uploads folder; its file name is the key.
   */
  documentKey(doc: { storagePath: string }): string {
    return isAbsolute(doc.storagePath) ? basename(doc.storagePath) : doc.storagePath;
  }

  /** The original uploaded bytes, verified against the checksum recorded at upload. */
  async readDocument(doc: { storagePath: string; sha256: string }): Promise<Uint8Array> {
    return this.storage.get(this.documentKey(doc), { sha256: doc.sha256 });
  }

  // ── Pipeline ─────────────────────────────────────────────────────────────

  /** Runs the pipeline job from wherever the invoice is. Safe to run twice: it no-ops when done. */
  async runPipeline(invoiceId: string): Promise<void> {
    let inv = await this.invoiceRow(this.db, invoiceId);
    try {
      if (inv.state === 'UPLOADED') {
        await this.transition(this.db, invoiceId, 'UPLOADED', 'EXTRACTING', { type: 'system' });
        inv = await this.invoiceRow(this.db, invoiceId);
      }
      if (inv.state === 'EXTRACTING') {
        const ok = await this.extract(invoiceId);
        if (!ok) return;
        inv = await this.invoiceRow(this.db, invoiceId);
      }
      // An invoice the ERP already holds a goods-receipt record for is compared with that record
      // (the receipt check); every other invoice goes through the full checks.
      if (inv.state === 'MATCHING' && (await this.receiptCheck(invoiceId))) return;
      if (inv.state === 'MATCHING') {
        await this.evaluate(invoiceId);
        this.#log?.info(
          { invoiceId, state: (await this.invoiceRow(this.db, invoiceId)).state },
          'invoice checked',
        );
      }
    } catch (error) {
      // A temporary outage (ERP, storage, database) is retried by the job runner, which fails
      // the invoice itself once the retries are used up (Phase 6 retry policy).
      if (isRetryable(error)) throw error;
      await this.fail(invoiceId, error);
    }
  }

  /**
   * Whether an ERP write for this invoice has an outcome Veyra does not know yet (Phase 4): sent
   * (or possibly sent) and not confirmed. Such an invoice is never failed or shown as ready; the
   * commit job keeps reconciling it.
   */
  async hasUnresolvedErpWrite(invoiceId: string): Promise<boolean> {
    return (
      await this.db
        .select({ status: t.erpWrites.status })
        .from(t.erpWrites)
        .where(eq(t.erpWrites.invoiceId, invoiceId))
    ).some((r) => r.status === 'unknown' || r.status === 'pending');
  }

  /** Moves an invoice in a system state to FAILED, recording where and why (never silently). */
  async fail(invoiceId: string, error: unknown): Promise<void> {
    const inv = await this.invoiceRow(this.db, invoiceId);
    const systemStates: InvoiceState[] = [
      'UPLOADED',
      'EXTRACTING',
      'MATCHING',
      'RESOLVING',
      'VALIDATING',
      'COMMITTING',
    ];
    if (!systemStates.includes(inv.state as InvoiceState)) throw error;
    // ERP failures are described by their safe message only (no host, credential or raw error).
    // Internal failures (SQL, filesystem, programming errors) get a generic reason; the detail
    // stays in the server log.
    if (isInternalError(error)) this.onInternalError(error, { invoiceId });
    const reason = isErpConnectorError(error)
      ? error.userMessage
      : isInternalError(error)
        ? INTERNAL_FAILURE_REASON
        : (error as Error).message;
    await this.db.transaction(async (tx) => {
      await this.transition(
        tx,
        invoiceId,
        inv.state as InvoiceState,
        'FAILED',
        { type: 'system' },
        {
          failedStage: inv.state,
          failureReason: reason.slice(0, 500),
        },
      );
      await this.audit(tx, invoiceId, { type: 'system' }, 'invoice.failed', {
        stage: inv.state,
        reason: reason.slice(0, 500),
      });
    });
  }

  /** READ. The extractor's output is untrusted: it is validated in full before anything uses it. */
  private extract(invoiceId: string): Promise<boolean> {
    return stage('EXTRACTION', () => this.read(invoiceId));
  }

  private async read(invoiceId: string): Promise<boolean> {
    const doc = (
      await this.db
        .select()
        .from(t.documents)
        .innerJoin(t.invoices, eq(t.invoices.documentId, t.documents.id))
        .where(eq(t.invoices.id, invoiceId))
        .limit(1)
    )[0]?.documents;
    if (!doc) throw new Error('document missing');
    let result: ExtractionResult;
    const started = Date.now();
    const about = { invoiceId, documentId: doc.id, mime: doc.mime, sizeBytes: doc.sizeBytes };
    try {
      // A reading started at upload is used when there is one; a temporary failure there is
      // simply read again now.
      const ahead = this.#ahead.get(doc.id);
      this.#ahead.delete(doc.id);
      const raw: unknown = ahead
        ? await ahead.catch((e: unknown) => {
            if (isRetryable(e)) return this.readDocumentNow(doc);
            throw e;
          })
        : await this.readDocumentNow(doc);
      const parsed = ExtractionResultSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          `The extractor returned invalid data: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        );
      result = parsed.data;
    } catch (error) {
      if (isRetryable(error)) throw error;
      this.#log?.warn(
        {
          ...about,
          durationMs: Date.now() - started,
          code: (error as { code?: unknown }).code ?? null,
          reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
        },
        'invoice could not be read',
      );
      await this.fail(invoiceId, error);
      return false;
    }
    {
      // Counts only: which readers ran and how much they read (no values, no document text).
      const all = [
        ...Object.values(result.header),
        ...result.lines.flatMap((l) =>
          Object.entries(l)
            .filter(([k]) => k !== 'lineNo')
            .map(([, f]) => f as { value: unknown; confidenceBp: number }),
        ),
      ];
      this.#log?.info(
        {
          ...about,
          durationMs: Date.now() - started,
          extractor: result.extractor.id,
          pages: result.pages,
          ...(result.diagnostics ?? {}),
          fieldsRead: all.filter((f) => f.value !== null).length,
          fieldsUncertain: all.filter((f) => f.confidenceBp < 9000).length,
          lines: result.lines.length,
          otherFields: result.otherFields?.length ?? 0,
          warnings: result.warnings.length,
          // Why the main reader was not used (a busy service, a wrong model name, a key): for
          // whoever runs Veyrafy. People see what it means for them, in plain words.
          readerFallback: result.warnings.find((w) => w.startsWith('The AI reader was ')) ?? null,
        },
        'invoice read',
      );
    }
    const extractionId = ulid();
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx.insert(t.extractions).values({
        id: extractionId,
        invoiceId,
        extractorId: result.extractor.id,
        extractorVersion: result.extractor.version,
        rawJson: JSON.stringify(result),
        createdAt: now,
      });
      const human = new Set(
        (
          await tx
            .select({ path: t.extractedFields.path })
            .from(t.extractedFields)
            .where(
              and(
                eq(t.extractedFields.invoiceId, invoiceId),
                inArray(t.extractedFields.source, ['human_confirmed', 'human_corrected']),
              ),
            )
        ).map((r) => r.path),
      );
      // Every field in ONE upsert and every line in ONE insert (Phase 7; previously one round
      // trip per field). Same rows, values and order: a path written twice keeps its first
      // position and its last value, exactly as the row-by-row upserts did.
      const fields = new Map<string, typeof t.extractedFields.$inferInsert>();
      const write = (
        path: FieldPath,
        f: { value: unknown; confidenceBp: number; evidence: unknown; source: string },
      ) => {
        if (human.has(path)) return; // human values are never overwritten by re-extraction
        fields.set(path, {
          id: fields.get(path)?.id ?? ulid(),
          invoiceId,
          path,
          valueJson: JSON.stringify(f.value),
          confidenceBp: f.confidenceBp,
          evidenceJson: f.evidence ? JSON.stringify(f.evidence) : null,
          evidenceDetailJson: null,
          source: 'extracted',
          method: f.source,
          extractionId,
          updatedByUserId: null,
          updatedAt: now,
        });
      };
      const lineNos = new Set<number>();
      for (const [key, f] of Object.entries(result.header))
        write(headerPath(key as HeaderFieldKey), f);
      for (const line of result.lines) {
        for (const [key, f] of Object.entries(line)) {
          if (key !== 'lineNo') write(linePath(line.lineNo, key as LineFieldKey), f as never);
        }
        lineNos.add(line.lineNo);
      }
      if (fields.size > 0)
        await tx
          .insert(t.extractedFields)
          .values([...fields.values()])
          .onConflictDoUpdate({
            target: [t.extractedFields.invoiceId, t.extractedFields.path],
            set: {
              valueJson: sql`excluded.value_json`,
              confidenceBp: sql`excluded.confidence_bp`,
              evidenceJson: sql`excluded.evidence_json`,
              evidenceDetailJson: null,
              source: 'extracted',
              method: sql`excluded.method`,
              extractionId,
              updatedByUserId: null,
              updatedAt: now,
            },
          });
      if (lineNos.size > 0)
        await tx
          .insert(t.invoiceLines)
          .values([...lineNos].map((lineNo) => ({ id: ulid(), invoiceId, lineNo })))
          .onConflictDoNothing();
      const { confidenceMinBp } = await this.settings(tx);
      const lowConfidence = [
        ...Object.entries(result.header)
          .filter(([, f]) => f.value !== null && f.confidenceBp < confidenceMinBp)
          .map(([k]) => `header.${k}`),
      ];
      const read = [
        ...Object.values(result.header),
        ...result.lines.flatMap((l) => LINE_FIELD_KEYS.map((k) => l[k])),
      ];
      const methods = [...new Set(read.filter((f) => f.value !== null).map((f) => f.source))];
      await this.audit(tx, invoiceId, { type: 'ai' }, 'extraction.completed', {
        extractor: result.extractor.id,
        extractorVersion: result.extractor.version,
        methods,
        lines: result.lines.length,
        pages: result.pages,
        lowConfidence,
        warnings: result.warnings,
      });
      await this.transition(tx, invoiceId, 'EXTRACTING', 'MATCHING', { type: 'system' });
    });
    return true;
  }

  async loadFields(db: Db, invoiceId: string): Promise<Map<string, StoredField>> {
    const rows = await db
      .select()
      .from(t.extractedFields)
      .where(eq(t.extractedFields.invoiceId, invoiceId))
      // By path in byte order: the order SQLite returned them in (its (invoice_id, path) index).
      .orderBy(sql`${t.extractedFields.path} collate "C"`);
    return new Map(rows.map((r) => [r.path, storedField(r)]));
  }

  async answers(db: Db, invoiceId: string): Promise<AnsweredDecision[]> {
    return (
      await db
        .select()
        .from(t.questions)
        .where(and(eq(t.questions.invoiceId, invoiceId), eq(t.questions.status, 'answered')))
        .orderBy(asc(t.questions.seq))
    ).map((q) => {
      const answer = JSON.parse(q.answerJson ?? '{}') as {
        optionId: string;
        input: JsonValue;
        effect: AnswerEffect;
      };
      return {
        questionId: q.id,
        code: q.code as QuestionCode,
        subjectKey: q.subjectKey,
        optionId: answer.optionId,
        effect: answer.effect,
        input: answer.input ?? null,
        userId: q.answeredByUserId ?? '',
        seq: q.answerSeq ?? 0,
      };
    });
  }

  /** One deterministic engine run over the invoice's current data. Reads only. */
  async engine(invoiceId: string): Promise<EngineOutput> {
    const settings = await this.settings();
    const lineCount = (
      await this.db.select().from(t.invoiceLines).where(eq(t.invoiceLines.invoiceId, invoiceId))
    ).length;
    return runEngine({
      invoiceId,
      today: this.today(),
      settings,
      fields: await this.loadFields(this.db, invoiceId),
      lineCount,
      answers: await this.answers(this.db, invoiceId),
      existingActions: (await this.db
        .select({
          id: t.creationActions.id,
          signature: t.creationActions.signature,
          status: t.creationActions.status,
        })
        .from(t.creationActions)
        .where(eq(t.creationActions.invoiceId, invoiceId))
        .orderBy(asc(t.creationActions.seq))) as {
        id: string;
        signature: string;
        status: 'staged' | 'committed' | 'discarded';
      }[],
      erp: this.erp,
      otherInvoicesWithKey: async (key) => {
        const others = await this.db
          .select()
          .from(t.invoices)
          .where(
            and(
              eq(t.invoices.dupVendorGstin, key.vendorGstin),
              eq(t.invoices.dupInvoiceNo, key.invoiceNoNormalized),
              eq(t.invoices.dupFy, key.fy),
              ne(t.invoices.id, invoiceId),
              ne(t.invoices.state, 'REJECTED'),
            ),
          )
          .orderBy(asc(t.invoices.seq));
        return Promise.all(
          others.map(async (o) => {
            const f = await this.loadFields(this.db, o.id);
            const date = readField<string>(f, 'header.invoiceDate', 0).value;
            const total = readField<number>(f, 'header.totalPaise', 0).value;
            return { id: o.id, state: o.state, invoiceDate: date, totalPaise: total };
          }),
        );
      },
      newId: ulid,
    });
  }

  /** MATCHING → RESOLVING → VALIDATING → NEEDS_INPUT | COMMITTING | FAILED, persisted atomically. */
  /** The engine's own stages (VALIDATION, MATCHING) are timed inside; the rest is PERSIST. */
  private evaluate(invoiceId: string): Promise<void> {
    return stage('PERSIST', () => this.evaluateAndPersist(invoiceId));
  }

  private async evaluateAndPersist(invoiceId: string): Promise<void> {
    const out = await this.engine(invoiceId);
    const now = this.now();
    let queuedCommit = false;
    await this.db.transaction(async (tx) => {
      // Locked: a concurrent run of the same invoice waits here, then sees it has moved on.
      const inv = await this.invoiceRow(tx, invoiceId, true);
      if (inv.state !== 'MATCHING') return; // another run got here first
      const runNo = inv.runNo + 1;
      const sys: Actor = { type: 'system' };

      // FIND (one insert for all matches, in order; Phase 7)
      if (out.matches.length > 0)
        await tx.insert(t.matchResults).values(
          out.matches.map((m) => ({
            id: ulid(),
            invoiceId,
            runNo,
            entity: m.entity,
            lineNo: m.lineNo,
            outcome: m.outcome,
            method: m.method,
            candidatesJson: JSON.stringify(m.candidates),
            chosenErpId: m.chosenErpId,
          })),
        );
      for (const f of out.derivedFields) {
        await tx
          .insert(t.extractedFields)
          .values({
            id: ulid(),
            invoiceId,
            path: f.path,
            valueJson: JSON.stringify(f.value),
            confidenceBp: null,
            evidenceJson: f.evidence ? JSON.stringify(f.evidence) : null,
            evidenceDetailJson: JSON.stringify(f.evidenceDetail),
            source: f.source,
            extractionId: null,
            updatedByUserId: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [t.extractedFields.invoiceId, t.extractedFields.path],
            set: {
              valueJson: JSON.stringify(f.value),
              evidenceDetailJson: JSON.stringify(f.evidenceDetail),
              source: f.source,
              confidenceBp: null,
              updatedAt: now,
            },
          });
        await this.audit(tx, invoiceId, sys, 'field.derived', {
          path: f.path,
          value: f.value,
          source: f.source,
          detail: f.evidenceDetail,
        });
      }
      await this.audit(tx, invoiceId, sys, 'match.recorded', {
        runNo,
        vendor: out.vendor ? refLabel(out.vendor) : null,
        po: out.po ? refLabel(out.po) : null,
        matches: out.matches.map((m) => ({
          entity: m.entity,
          lineNo: m.lineNo,
          outcome: m.outcome,
          method: m.method,
          chosen: m.chosenErpId,
        })),
      });
      await this.transition(tx, invoiceId, 'MATCHING', 'RESOLVING', sys, {
        runNo,
        vendorErpId: out.vendor?.kind === 'erp' ? out.vendor.id : null,
        poErpId: out.po?.kind === 'erp' ? out.po.id : null,
      });

      // USE / IF MISSING, CREATE (staged; nothing reaches the ERP yet)
      const existing = await tx
        .select()
        .from(t.creationActions)
        .where(eq(t.creationActions.invoiceId, invoiceId))
        .orderBy(asc(t.creationActions.seq));
      const planned = new Set(out.actions.map((a) => a.id));
      for (const a of out.actions) {
        if (existing.some((e) => e.id === a.id)) continue;
        await tx.insert(t.creationActions).values({
          id: a.id,
          invoiceId,
          entity: a.entity,
          payloadJson: JSON.stringify(a.payload),
          signature: a.signature,
          policyCode: a.policyCode,
          trigger: a.trigger,
          approvedByUserId: a.approvedByUserId,
          questionId: a.questionId,
          status: 'staged',
          erpId: null,
          idempotencyKey: `veyra:${invoiceId}:${a.id}`,
          createdAt: now,
          committedAt: null,
        });
        await this.audit(
          tx,
          invoiceId,
          a.trigger === 'user_approval' ? { type: 'user', userId: a.approvedByUserId ?? '' } : sys,
          a.trigger === 'user_approval' ? 'creation.approved' : 'creation.staged',
          { actionId: a.id, entity: a.entity, policyCode: a.policyCode, payload: a.payload },
        );
      }
      for (const e of existing) {
        if (e.status === 'staged' && !planned.has(e.id)) {
          await tx
            .update(t.creationActions)
            .set({ status: 'discarded' })
            .where(eq(t.creationActions.id, e.id));
          await this.audit(tx, invoiceId, sys, 'creation.discarded', {
            actionId: e.id,
            entity: e.entity,
            reason: 'no longer needed',
          });
        }
      }
      for (const line of out.lines) {
        await tx
          .update(t.invoiceLines)
          .set({
            itemErpId: line.item?.kind === 'erp' ? line.item.id : null,
            itemRefStagedActionId: line.item?.kind === 'staged' ? line.item.actionId : null,
            poLineErpId: line.poLine?.kind === 'erp' ? line.poLine.id : null,
          })
          .where(
            and(eq(t.invoiceLines.invoiceId, invoiceId), eq(t.invoiceLines.lineNo, line.lineNo)),
          );
      }
      await this.transition(tx, invoiceId, 'RESOLVING', 'VALIDATING', sys);

      // VALIDATE (one insert for every rule result, in order; Phase 7)
      if (out.validations.length > 0)
        await tx.insert(t.validationResults).values(
          out.validations.map((r) => ({
            id: ulid(),
            invoiceId,
            runNo,
            ruleCode: r.ruleCode,
            lineNo: r.lineNo,
            outcome: r.outcome,
            naReason: r.naReason,
            expectedJson: JSON.stringify(r.expected),
            actualJson: JSON.stringify(r.actual),
            message: r.message,
            createdAt: now,
          })),
        );
      const failed = out.validations
        .filter((r) => r.outcome === 'fail')
        .map((r) => (r.lineNo ? `${r.ruleCode}:line:${r.lineNo}` : r.ruleCode));
      await this.audit(tx, invoiceId, sys, 'validation.completed', {
        runNo,
        passed: out.validations.filter((r) => r.outcome === 'pass').length,
        failed,
        notApplicable: out.validations
          .filter((r) => r.outcome === 'not_applicable')
          .map((r) => `${r.ruleCode}:${r.naReason}`),
        notEvaluated: out.validations.filter((r) => r.outcome === 'not_evaluated').length,
      });
      await this.syncQuestions(tx, invoiceId, out.questions);
      const dup = out.duplicateKey;
      const patch = {
        dupVendorGstin: dup?.vendorGstin ?? null,
        dupInvoiceNo: dup?.invoiceNoNormalized ?? null,
        dupFy: dup?.fy ?? null,
      };

      // ASK, or COMMIT automatically (there is no human "verify" step)
      if (out.questions.length > 0) {
        await this.transition(tx, invoiceId, 'VALIDATING', 'NEEDS_INPUT', sys, patch);
      } else if (out.plan) {
        await this.transition(tx, invoiceId, 'VALIDATING', 'COMMITTING', sys, {
          ...patch,
          commitPlanJson: JSON.stringify(out.plan),
        });
        await this.enqueue(tx, invoiceId, 'commit');
        queuedCommit = true;
      } else {
        // Safety net (RULES §4): a failed or unevaluated rule with no question is never passed.
        await this.transition(tx, invoiceId, 'VALIDATING', 'FAILED', sys, {
          ...patch,
          failedStage: 'VALIDATING',
          failureReason: 'INVARIANT_VIOLATION: a check did not pass but no question was raised.',
        });
        await this.audit(tx, invoiceId, sys, 'invoice.failed', {
          stage: 'VALIDATING',
          reason: 'INVARIANT_VIOLATION',
          rules: failed,
        });
      }
    });
    if (queuedCommit) this.onEnqueue();
  }

  /** Questions are idempotent by (code, subject): keep what is still asked, supersede the rest. */
  private async syncQuestions(
    tx: VeyraTx,
    invoiceId: string,
    drafts: readonly QuestionDraft[],
  ): Promise<void> {
    const open = await tx
      .select()
      .from(t.questions)
      .where(and(eq(t.questions.invoiceId, invoiceId), eq(t.questions.status, 'open')))
      .orderBy(asc(t.questions.seq));
    const userId = (await this.settings(tx)).designatedUserId;
    const now = this.now();
    for (const q of open) {
      if (!drafts.some((d) => d.code === q.code && d.subjectKey === q.subjectKey)) {
        await tx.update(t.questions).set({ status: 'superseded' }).where(eq(t.questions.id, q.id));
        await this.audit(tx, invoiceId, { type: 'system' }, 'question.superseded', {
          questionId: q.id,
          code: q.code,
          summary: summaryOf(q.contextJson),
        });
      }
    }
    for (const d of drafts) {
      const context = {
        summary: d.summary,
        evidence: d.evidence,
        facts: d.facts,
        why: d.why,
        paths: d.paths,
        optionMeta: Object.fromEntries(
          d.options.map((o) => [o.id, { emphasis: o.emphasis, result: o.result }]),
        ),
      };
      const inputs: Record<string, InputSpec> = {};
      for (const o of d.options) if (o.input) inputs[o.id] = o.input;
      const values = {
        prompt: d.headline,
        contextJson: JSON.stringify(context),
        optionsJson: JSON.stringify(
          d.options.map((o) => ({ id: o.id, label: o.label, effect: o.effect })),
        ),
        inputSchemaJson: Object.keys(inputs).length ? JSON.stringify(inputs) : null,
      };
      const current = open.find((q) => q.code === d.code && q.subjectKey === d.subjectKey);
      if (current) {
        await tx.update(t.questions).set(values).where(eq(t.questions.id, current.id));
        continue;
      }
      const id = ulid();
      await tx.insert(t.questions).values({
        id,
        invoiceId,
        kind: d.kind,
        code: d.code,
        subjectKey: d.subjectKey,
        ...values,
        status: 'open',
        assignedToUserId: userId,
        answerJson: null,
        answeredByUserId: null,
        answeredAt: null,
        answerSeq: null,
        createdAt: now,
      });
      await this.audit(tx, invoiceId, { type: 'system' }, 'question.raised', {
        questionId: id,
        code: d.code,
        kind: d.kind,
        summary: d.summary,
        evidence: d.evidence,
        headline: d.headline,
      });
    }
  }

  // ── Answers, rejection, reprocessing ─────────────────────────────────────

  /**
   * Records the designated user's answer. The option must exist on the question, its input is
   * parsed server-side, and its typed effect is applied as data. Then the invoice re-runs from
   * MATCHING (or is rejected). The client decides nothing.
   */
  async answer(
    questionId: string,
    body: { optionId: string; input: unknown },
    userId: string,
  ): Promise<void> {
    return stage('QUESTION', () => this.recordAnswer(questionId, body, userId));
  }

  private async recordAnswer(
    questionId: string,
    body: { optionId: string; input: unknown },
    userId: string,
  ): Promise<void> {
    await this.requireActor(userId, 'questions.answer');
    const q = (
      await this.db.select().from(t.questions).where(eq(t.questions.id, questionId)).limit(1)
    )[0];
    if (!q) throw new VeyraError('NOT_FOUND', 'Question not found.');
    if (q.status !== 'open')
      throw new VeyraError('INVALID_STATE', 'This question has already been answered.');
    const inv = await this.invoiceRow(this.db, q.invoiceId);
    if (inv.state !== 'NEEDS_INPUT')
      throw new VeyraError('INVALID_STATE', 'This invoice is not waiting for an answer.');
    const options = JSON.parse(q.optionsJson) as {
      id: string;
      label: string;
      effect: AnswerEffect;
    }[];
    const option = options.find((o) => o.id === body.optionId);
    if (!option) throw new VeyraError('INVALID_INPUT', 'That is not one of the options.');
    // Rejecting an invoice through a question is still a rejection.
    if (option.effect.type === 'REJECT_INVOICE') await this.requireActor(userId, 'invoices.reject');
    const specs = (q.inputSchemaJson ? JSON.parse(q.inputSchemaJson) : {}) as Record<
      string,
      InputSpec
    >;
    const spec = specs[option.id] ?? null;
    const parsed = parseAnswerInput(spec, body.input);
    if (!parsed.ok) throw new VeyraError('INVALID_INPUT', parsed.message);
    const effect = option.effect;
    const user: Actor = { type: 'user', userId };
    const now = this.now();
    const context = JSON.parse(q.contextJson) as {
      summary?: string;
      optionMeta?: Record<string, { result?: string }>;
    };

    await this.db.transaction(async (tx) => {
      // Answers are numbered globally ("the latest decision"): serialise numbering across
      // concurrent requests and workers for the rest of this transaction.
      await tx.execute(sql`select pg_advisory_xact_lock(${ANSWER_SEQ_LOCK}::bigint)`);
      const seq =
        ((
          await tx
            .select({ m: max(t.questions.answerSeq) })
            .from(t.questions)
            .limit(1)
        )[0]?.m ?? 0) + 1;
      const answered = await tx
        .update(t.questions)
        .set({
          status: 'answered',
          answerJson: JSON.stringify({ optionId: option.id, input: parsed.value, effect }),
          answeredByUserId: userId,
          answeredAt: now,
          answerSeq: seq,
        })
        .where(and(eq(t.questions.id, q.id), eq(t.questions.status, 'open')))
        .returning({ id: t.questions.id });
      // Answered concurrently by another request: nothing of this answer is kept.
      if (answered.length !== 1)
        throw new VeyraError('INVALID_STATE', 'This question has already been answered.');
      await this.audit(tx, q.invoiceId, user, 'question.answered', {
        questionId: q.id,
        code: q.code,
        summary: context.summary ?? q.code,
        option: option.label,
        effect: effect.type,
        result: context.optionMeta?.[option.id]?.result ?? '',
        input: parsed.value,
      });

      if (effect.type === 'SET_FIELD' || effect.type === 'CONFIRM_FIELD') {
        const path = effect.path;
        const fields = await this.loadFields(tx, q.invoiceId);
        const current = fields.get(path);
        const value = effect.type === 'SET_FIELD' ? parsed.value : (current?.value ?? null);
        const source: FieldSource =
          effect.type === 'SET_FIELD' ? 'human_corrected' : 'human_confirmed';
        await tx
          .insert(t.extractedFields)
          .values({
            id: ulid(),
            invoiceId: q.invoiceId,
            path,
            valueJson: JSON.stringify(value),
            confidenceBp: current?.confidenceBp ?? null,
            evidenceJson: current?.evidence ? JSON.stringify(current.evidence) : null,
            evidenceDetailJson: null,
            source,
            extractionId: null,
            updatedByUserId: userId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [t.extractedFields.invoiceId, t.extractedFields.path],
            set: {
              valueJson: JSON.stringify(value),
              source,
              updatedByUserId: userId,
              updatedAt: now,
            },
          });
        await this.audit(
          tx,
          q.invoiceId,
          user,
          effect.type === 'SET_FIELD' ? 'field.corrected' : 'field.confirmed',
          { path, from: current?.value ?? null, to: value },
        );
      }

      if (effect.type === 'REJECT_INVOICE') {
        await this.rejectInTx(tx, q.invoiceId, 'NEEDS_INPUT', userId, option.label);
        return;
      }
      await this.transition(tx, q.invoiceId, 'NEEDS_INPUT', 'MATCHING', user);
      await this.enqueue(tx, q.invoiceId, 'pipeline');
    });
    this.onEnqueue();
  }

  private async rejectInTx(
    tx: VeyraTx,
    invoiceId: string,
    from: InvoiceState,
    userId: string,
    reason: string,
  ): Promise<void> {
    const user: Actor = { type: 'user', userId };
    await this.transition(tx, invoiceId, from, 'REJECTED', user, {
      rejectedByUserId: userId,
      rejectedReason: reason,
      commitPlanJson: null,
    });
    await this.audit(tx, invoiceId, user, 'invoice.rejected', { reason });
    // D1: staged records never reach the ERP; a confirmed GRN stays here, discarded, for the audit trail.
    const staged = await tx
      .select()
      .from(t.creationActions)
      .where(
        and(eq(t.creationActions.invoiceId, invoiceId), eq(t.creationActions.status, 'staged')),
      )
      .orderBy(asc(t.creationActions.seq));
    for (const a of staged) {
      await tx
        .update(t.creationActions)
        .set({ status: 'discarded' })
        .where(eq(t.creationActions.id, a.id));
      await this.audit(tx, invoiceId, { type: 'system' }, 'creation.discarded', {
        actionId: a.id,
        entity: a.entity,
        reason: 'invoice rejected',
        payload: JSON.parse(a.payloadJson),
      });
    }
    const open = await tx
      .select()
      .from(t.questions)
      .where(and(eq(t.questions.invoiceId, invoiceId), eq(t.questions.status, 'open')))
      .orderBy(asc(t.questions.seq));
    for (const q of open) {
      await tx.update(t.questions).set({ status: 'superseded' }).where(eq(t.questions.id, q.id));
    }
  }

  /** Explicit business rejection by the designated user (from NEEDS_INPUT or FAILED). */
  async reject(invoiceId: string, reason: string, userId: string): Promise<void> {
    await this.requireActor(userId, 'invoices.reject');
    const inv = await this.invoiceRow(this.db, invoiceId);
    if (inv.state !== 'NEEDS_INPUT' && inv.state !== 'FAILED')
      throw new VeyraError('INVALID_STATE', 'Only invoices waiting for you can be rejected.');
    await this.db.transaction(
      async (tx) => await this.rejectInTx(tx, invoiceId, inv.state as InvoiceState, userId, reason),
    );
  }

  /** FAILED → EXTRACTING (extraction never finished) or MATCHING (re-run on the stored reading). */
  async reprocess(invoiceId: string, userId: string): Promise<void> {
    await this.requireActor(userId, 'invoices.reprocess');
    const inv = await this.invoiceRow(this.db, invoiceId);
    if (inv.state !== 'FAILED')
      throw new VeyraError('INVALID_STATE', 'Only failed invoices can be processed again.');
    const extracted = (
      await this.db
        .select()
        .from(t.extractions)
        .where(eq(t.extractions.invoiceId, invoiceId))
        .limit(1)
    )[0];
    const to: InvoiceState =
      extracted && inv.failedStage !== 'EXTRACTING' && inv.failedStage !== 'UPLOADED'
        ? 'MATCHING'
        : 'EXTRACTING';
    await this.db.transaction(async (tx) => {
      await this.transition(
        tx,
        invoiceId,
        'FAILED',
        to,
        { type: 'user', userId },
        { failedStage: null, failureReason: null },
      );
      await this.enqueue(tx, invoiceId, 'pipeline');
    });
    this.onEnqueue();
  }

  // ── ERP goods-receipt records (the receipt check) ────────────────────────

  /** Imports the ERP's goods-receipt JSON export. Each record is kept as the ERP sent it. */
  async importReceipts(
    sourceFilename: string,
    json: unknown,
    userId: string,
  ): Promise<{ imported: number }> {
    await this.requireActor(userId, 'imports.manage');
    const parsed = ReceiptFileSchema.safeParse(json);
    if (!parsed.success)
      throw new VeyraError(
        'INVALID_INPUT',
        "This file isn't a goods-receipt export Veyrafy recognises. Check that you chose the file exported from your ERP.",
        // For whoever supports the import (never shown as the message): what did not fit.
        {
          field: parsed.error.issues[0]?.path.join('.') ?? '',
          problem: parsed.error.issues[0]?.message ?? '',
        },
      );
    const now = this.now();
    await this.db.transaction(async (tx) => {
      for (const raw of parsed.data.data) {
        const record = normalizeReceipt(raw);
        const attachment = (raw.images ?? []).find((i) =>
          ['application/pdf', 'image/png', 'image/jpeg'].includes(i.mime_type),
        );
        await tx.insert(t.erpReceiptRecords).values({
          id: ulid(),
          invoiceNoKey: invoiceNoKey(record.invoiceNo),
          vendorName: record.vendorName,
          grnNo: record.grnNo,
          recordJson: JSON.stringify(record),
          attachmentName: attachment?.file_name ?? null,
          attachmentBase64: attachment?.base64 ?? null,
          sourceFilename,
          importedByUserId: userId,
          importedAt: now,
        });
      }
      await this.audit(tx, null, { type: 'user', userId }, 'receipts.imported', {
        file: sourceFilename,
        records: parsed.data.data.length,
      });
    });
    return { imported: parsed.data.data.length };
  }

  async listReceipts() {
    const rows = await this.db
      .select()
      .from(t.erpReceiptRecords)
      .orderBy(desc(t.erpReceiptRecords.seq));
    return rows.map((r) => {
      const rec = JSON.parse(r.recordJson) as ReceiptRecord;
      return {
        id: r.id,
        grnNo: r.grnNo,
        grnDate: rec.grnDate,
        vendorName: r.vendorName,
        invoiceNo: rec.invoiceNo,
        lines: rec.lines.length,
        attachment: r.attachmentName,
        importedAt: r.importedAt,
      };
    });
  }

  /** Runs the invoice attached to an ERP receipt record through Veyrafy, like an upload. */
  async checkReceiptAttachment(recordId: string, userId: string) {
    const row = (
      await this.db
        .select()
        .from(t.erpReceiptRecords)
        .where(eq(t.erpReceiptRecords.id, recordId))
        .limit(1)
    )[0];
    if (!row) throw new VeyraError('NOT_FOUND', 'ERP receipt record not found.');
    if (!row.attachmentBase64 || !row.attachmentName)
      throw new VeyraError('INVALID_INPUT', 'This ERP record has no invoice attached.');
    return this.upload(
      {
        filename: row.attachmentName,
        bytes: new Uint8Array(Buffer.from(row.attachmentBase64, 'base64')),
      },
      userId,
    );
  }

  /** What the invoice says, from usable readings only (an unclear value counts as not read). */
  async invoiceSide(invoiceId: string): Promise<InvoiceSide> {
    const f = await this.loadFields(this.db, invoiceId);
    const min = (await this.settings()).confidenceMinBp;
    const v = <T extends string | number>(path: string) =>
      readField<T>(f, path as never, min).value;
    const lines = await this.db
      .select({ lineNo: t.invoiceLines.lineNo })
      .from(t.invoiceLines)
      .where(eq(t.invoiceLines.invoiceId, invoiceId))
      .orderBy(asc(t.invoiceLines.lineNo));
    const x = (
      await this.db
        .select({ rawJson: t.extractions.rawJson })
        .from(t.extractions)
        .where(eq(t.extractions.invoiceId, invoiceId))
        .orderBy(desc(t.extractions.createdAt), desc(t.extractions.seq))
        .limit(1)
    )[0];
    const other = x
      ? ((JSON.parse(x.rawJson) as { otherFields?: { label: string; value: string }[] })
          .otherFields ?? [])
      : [];
    const freight = other
      .filter((o) => /freight|cartage|carriage|transport/i.test(o.label))
      .map((o) => toPaise(o.value.replace(/[₹\s]|Rs\.?/gi, '')))
      .filter((p): p is number => p !== null);
    return {
      vendorName: v<string>('header.vendorName'),
      vendorGstin: v<string>('header.vendorGstin'),
      invoiceNumber: v<string>('header.invoiceNumber'),
      invoiceDate: v<string>('header.invoiceDate'),
      poNumber: v<string>('header.poNumber'),
      cgstPaise: v<number>('header.cgstPaise'),
      sgstPaise: v<number>('header.sgstPaise'),
      igstPaise: v<number>('header.igstPaise'),
      roundOffPaise: v<number>('header.roundOffPaise'),
      totalPaise: v<number>('header.totalPaise'),
      freightPaise: freight.length ? freight.reduce((a, b) => a + b, 0) : null,
      lines: lines.map(({ lineNo }) => ({
        lineNo,
        description: v<string>(`lines[${lineNo}].description`),
        hsnSac: v<string>(`lines[${lineNo}].hsnSac`),
        uom: v<string>(`lines[${lineNo}].uom`),
        qtyMilli: v<number>(`lines[${lineNo}].qtyMilli`),
        unitPricePaise: v<number>(`lines[${lineNo}].unitPricePaise`),
        taxablePaise: v<number>(`lines[${lineNo}].taxablePaise`),
      })),
    };
  }

  /** The ERP receipt record this invoice belongs to, if the ERP exported one. */
  async receiptRecordFor(side: InvoiceSide): Promise<ReceiptRecord | null> {
    if (!side.invoiceNumber) return null;
    const rows = await this.db
      .select()
      .from(t.erpReceiptRecords)
      .where(eq(t.erpReceiptRecords.invoiceNoKey, invoiceNoKey(side.invoiceNumber)))
      .orderBy(asc(t.erpReceiptRecords.seq));
    const picked = pickRecord(
      rows.map((r) => ({ record: JSON.parse(r.recordJson) as ReceiptRecord })),
      side.vendorName,
    );
    return picked?.record ?? null;
  }

  /**
   * The receipt check: when the ERP holds a goods-receipt record for this invoice, compare the
   * two value by value. Every value matching clears the invoice (nothing is written to the
   * ERP); any difference, or a value not read with certainty, waits for a person.
   */
  private async receiptCheck(invoiceId: string): Promise<boolean> {
    const side = await this.invoiceSide(invoiceId);
    const record = await this.receiptRecordFor(side);
    if (!record) return false;
    const { comparison: c, unread } = receiptComparison(side, record);
    // A value not read with certainty is asked, exactly as on the ERP-checks path (RULES §5).
    const fields = await this.loadFields(this.db, invoiceId);
    const min = (await this.settings()).confidenceMinBp;
    const questions = unread.map((path) => {
      const read = readField(fields, path as never, min);
      return mdField(path as never, {
        state: read.state === 'usable' ? 'absent' : read.state,
        shown: read.field?.value ?? null,
      });
    });
    const system: Actor = { type: 'system' };
    await this.db.transaction(async (tx) => {
      await this.transition(tx, invoiceId, 'MATCHING', 'RESOLVING', system);
      await this.transition(tx, invoiceId, 'RESOLVING', 'VALIDATING', system);
      await this.audit(tx, invoiceId, system, 'receipt.checked', {
        grnNo: record.grnNo,
        verdict: c.verdict,
        matched: c.matched,
        mismatched: c.mismatched,
        notChecked: c.notChecked,
        summary: c.summary.slice(0, 2000),
      });
      await this.syncQuestions(tx, invoiceId, questions);
      if (c.verdict === 'cleared') {
        await this.transition(tx, invoiceId, 'VALIDATING', 'COMMITTING', system);
        await this.transition(tx, invoiceId, 'COMMITTING', 'VERIFIED_PENDING_PAYMENT', system);
      } else {
        await this.transition(tx, invoiceId, 'VALIDATING', 'NEEDS_INPUT', system);
      }
    });
    return true;
  }

  /** Checks an invoice against its ERP receipt record again (after the ERP was corrected). */
  async recheckReceipt(invoiceId: string, userId: string): Promise<void> {
    await this.requireActor(userId, 'invoices.reprocess');
    const inv = await this.invoiceRow(this.db, invoiceId);
    if (inv.state !== 'NEEDS_INPUT')
      throw new VeyraError('INVALID_STATE', 'Only invoices waiting for you can be checked again.');
    await this.db.transaction(async (tx) => {
      await this.transition(tx, invoiceId, 'NEEDS_INPUT', 'MATCHING', { type: 'user', userId });
      await this.enqueue(tx, invoiceId, 'pipeline');
    });
    this.onEnqueue();
  }

  // ── Commit ───────────────────────────────────────────────────────────────

  /** COMMITTING (decision D4): automatic, restartable, idempotent. See ./commit.ts. */
  async runCommit(invoiceId: string): Promise<void> {
    await stage('COMMIT', async () => {
      const inv = await this.invoiceRow(this.db, invoiceId);
      if (inv.state !== 'COMMITTING') return;
      await executeCommit(this, invoiceId, JSON.parse(inv.commitPlanJson ?? 'null') as CommitPlan);
    });
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  /** Heartbeat: the job is still being worked on (renews its lease). */
  async touchJob(id: string): Promise<void> {
    await this.db
      .update(t.jobs)
      .set({ lockedAt: this.now() })
      .where(and(eq(t.jobs.id, id), eq(t.jobs.status, 'running')));
  }

  /**
   * Running jobs whose lease expired: the worker that claimed them stopped (crash, kill, lost
   * host) without finishing, including this process before a restart. A live worker renews its
   * jobs' leases (`touchJob`), so this never takes a job from a worker that is still running.
   */
  async expiredJobs(
    leaseMs: number,
  ): Promise<{ id: string; invoiceId: string; attempts: number }[]> {
    const cutoff = new Date(this.clock().getTime() - leaseMs).toISOString();
    return this.db
      .select({ id: t.jobs.id, invoiceId: t.jobs.invoiceId, attempts: t.jobs.attempts })
      .from(t.jobs)
      .where(and(eq(t.jobs.status, 'running'), lte(t.jobs.lockedAt, cutoff)))
      .orderBy(asc(t.jobs.seq));
  }

  /** Puts a claimed job back in the queue (shutdown, or an expired lease). */
  async releaseJob(id: string): Promise<void> {
    await this.db
      .update(t.jobs)
      .set({ status: 'queued', lockedAt: null, updatedAt: this.now() })
      .where(and(eq(t.jobs.id, id), eq(t.jobs.status, 'running')));
  }

  /** Job counts for readiness and diagnostics (no payloads). */
  async jobStats(leaseMs: number): Promise<{
    queued: number;
    running: number;
    expired: number;
    failedLast24h: number;
    oldestQueuedAgeMs: number | null;
  }> {
    const now = this.clock().getTime();
    const rows = await this.db
      .select({
        status: t.jobs.status,
        lockedAt: t.jobs.lockedAt,
        runAfter: t.jobs.runAfter,
        updatedAt: t.jobs.updatedAt,
      })
      .from(t.jobs)
      .where(ne(t.jobs.status, 'succeeded'));
    const queued = rows.filter((r) => r.status === 'queued');
    const due = queued.map((r) => Date.parse(r.runAfter)).filter((x) => x <= now);
    return {
      queued: queued.length,
      running: rows.filter((r) => r.status === 'running').length,
      expired: rows.filter(
        (r) => r.status === 'running' && r.lockedAt && Date.parse(r.lockedAt) < now - leaseMs,
      ).length,
      failedLast24h: rows.filter(
        (r) => r.status === 'failed' && Date.parse(r.updatedAt) > now - 24 * 60 * 60 * 1000,
      ).length,
      oldestQueuedAgeMs: due.length ? now - Math.min(...due) : null,
    };
  }

  /**
   * Claims the oldest due job, atomically, for one worker. PostgreSQL (ARCHITECTURE §19):
   * - claims are serialised by a transaction-scoped advisory lock, so two workers can never take
   *   the same job (the status update is also conditional on `queued`);
   * - a job is not claimed while another job of the same invoice is running, so one invoice is
   *   never processed by two workers at once (what the single SQLite worker guaranteed).
   */
  async claimJob(): Promise<{
    id: string;
    invoiceId: string;
    type: 'pipeline' | 'commit';
    attempts: number;
    readyAt: string;
  } | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK}::bigint)`);
      const busy = tx
        .select({ invoiceId: t.jobs.invoiceId })
        .from(t.jobs)
        .where(eq(t.jobs.status, 'running'));
      const job = (
        await tx
          .select()
          .from(t.jobs)
          .where(
            and(
              eq(t.jobs.status, 'queued'),
              lte(t.jobs.runAfter, this.now()),
              notInArray(t.jobs.invoiceId, busy),
            ),
          )
          .orderBy(asc(t.jobs.runAfter), asc(t.jobs.seq))
          .limit(1)
      )[0];
      if (!job) return null;
      const claimed = await tx
        .update(t.jobs)
        .set({
          status: 'running',
          lockedAt: this.now(),
          attempts: job.attempts + 1,
          updatedAt: this.now(),
        })
        .where(and(eq(t.jobs.id, job.id), eq(t.jobs.status, 'queued')))
        .returning({ id: t.jobs.id });
      if (claimed.length !== 1) return null;
      return {
        id: job.id,
        invoiceId: job.invoiceId,
        type: job.type as 'pipeline' | 'commit',
        attempts: job.attempts + 1,
        // When it became ready to run: queue wait is measured from here.
        readyAt: job.runAfter > job.createdAt ? job.runAfter : job.createdAt,
      };
    });
  }

  async finishJob(
    id: string,
    outcome:
      | { status: 'succeeded' }
      | { status: 'failed'; error: string }
      | { status: 'retry'; error: string; delayMs: number },
  ): Promise<void> {
    const now = this.clock().getTime();
    await this.db
      .update(t.jobs)
      .set(
        outcome.status === 'retry'
          ? {
              status: 'queued',
              lockedAt: null,
              lastError: outcome.error,
              runAfter: new Date(now + outcome.delayMs).toISOString(),
              updatedAt: this.now(),
            }
          : {
              status: outcome.status,
              lockedAt: null,
              lastError: outcome.status === 'failed' ? outcome.error : null,
              updatedAt: this.now(),
            },
      )
      .where(eq(t.jobs.id, id));
  }

  async pendingJobs(): Promise<number> {
    return (
      await this.db
        .select({ id: t.jobs.id })
        .from(t.jobs)
        .where(inArray(t.jobs.status, ['queued', 'running']))
    ).length;
  }

  /** The invoice's jobs, newest first. */
  async latestJobs(invoiceId: string) {
    return this.db
      .select()
      .from(t.jobs)
      .where(eq(t.jobs.invoiceId, invoiceId))
      .orderBy(desc(t.jobs.createdAt), desc(t.jobs.seq));
  }
}

/** Advisory-lock key numbering answers (see `answer`). */
const ANSWER_SEQ_LOCK = 7_665_002;

/** Advisory-lock key serialising job claims across workers. */
const CLAIM_LOCK = 7_665_001;

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Cheap structural checks before a document is stored (Phase 3D). Images: the header must be
 * readable and the size within the OCR limits, checked without decoding a pixel. PDFs: the file
 * must end properly (a truncated upload has no end-of-file marker). Page count, encryption and
 * damaged content are found while reading, and fail the invoice visibly.
 */
function checkDocumentShape(
  bytes: Uint8Array,
  mime: 'application/pdf' | 'image/png' | 'image/jpeg',
) {
  if (mime === 'application/pdf') {
    const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 8192))).toString('latin1');
    if (!tail.includes('%%EOF'))
      throw new VeyraError(
        'UNSUPPORTED_FILE',
        'The PDF looks incomplete or damaged. Upload the original file again.',
      );
    return;
  }
  try {
    checkImageSize(imageSize(bytes));
  } catch (error) {
    throw new VeyraError(
      'UNSUPPORTED_FILE',
      error instanceof Error ? error.message : 'The image could not be read.',
    );
  }
}

/** "20 MB", "64 KB": the upload limit as a person reads it. */
export function uploadLimitText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1
    ? `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

function safeFilename(name: string, ext: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  return base.trim() === '' ? `invoice.${ext}` : base;
}

function refLabel(ref: { kind: 'erp'; id: string } | { kind: 'staged'; actionId: string }): string {
  return ref.kind === 'erp' ? ref.id : `new (${ref.actionId})`;
}

function summaryOf(contextJson: string): string {
  try {
    return String((JSON.parse(contextJson) as { summary?: string }).summary ?? '');
  } catch {
    return '';
  }
}
