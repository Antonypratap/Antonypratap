import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, inArray, lte, max, ne, sql } from 'drizzle-orm';
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
import type { ErpConnector } from '@veyra/erp-connector';
import { checkImageSize, imageSize, sniffDocument, type Extractor } from '@veyra/extractor';
import type { VeyraDb, VeyraTx } from '../db/open';
import * as t from '../db/schema';
import { ulid } from '../ids';
import { readField, type JsonValue, type StoredField } from '../engine/fields';
import { runEngine } from '../engine/run';
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

type Db = VeyraDb | VeyraTx;

export const DEMO_USER = {
  id: '00000000000000000000000001',
  name: 'Demo Approver',
  email: 'approver@veyra.local',
} as const;

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
      | 'NOT_DESIGNATED_USER',
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
  storageDir: string;
  clock?: () => Date;
  initialSettings?: Omit<VeyraSettings, 'designatedUserId'>;
  commitHooks?: CommitHooks;
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
  readonly storageDir: string;
  readonly clock: () => Date;
  readonly commitHooks: CommitHooks;
  /** Called after work is queued, so a running job loop picks it up at once. */
  onEnqueue: () => void = () => undefined;

  constructor(options: VeyraOptions) {
    this.db = options.db;
    this.erp = options.erp;
    this.extractor = options.extractor;
    this.storageDir = options.storageDir;
    this.clock = options.clock ?? (() => new Date());
    this.commitHooks = options.commitHooks ?? {};
    mkdirSync(this.storageDir, { recursive: true });
    this.bootstrap(options.initialSettings ?? DEFAULT_SETTINGS);
  }

  now(): string {
    return this.clock().toISOString();
  }

  /** Today in India (Asia/Kolkata), as YYYY-MM-DD. */
  today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(this.clock());
  }

  // ── Setup ────────────────────────────────────────────────────────────────

  private bootstrap(initial: Omit<VeyraSettings, 'designatedUserId'>): void {
    const now = this.now();
    this.db.transaction((tx) => {
      if (!tx.select().from(t.users).where(eq(t.users.id, DEMO_USER.id)).get()) {
        tx.insert(t.users)
          .values({ ...DEMO_USER, active: true, createdAt: now })
          .run();
      }
      const values: VeyraSettings = { ...initial, designatedUserId: DEMO_USER.id };
      for (const [k, key] of Object.entries(SETTING_KEYS)) {
        if (!tx.select().from(t.settings).where(eq(t.settings.key, key)).get()) {
          tx.insert(t.settings)
            .values({
              key,
              valueJson: JSON.stringify(values[k as keyof VeyraSettings]),
              updatedByUserId: null,
              updatedAt: now,
            })
            .run();
        }
      }
    });
  }

  settings(db: Db = this.db): VeyraSettings {
    const rows = db.select().from(t.settings).all();
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
  designatedUserId(): string {
    return this.settings().designatedUserId;
  }

  // ── Audit and transitions ────────────────────────────────────────────────

  audit(
    db: Db,
    invoiceId: string | null,
    actor: Actor,
    event: (typeof t.auditEvents.$inferInsert)['event'],
    detail: Record<string, JsonValue>,
    states: { from: InvoiceState; to: InvoiceState } | null = null,
  ): void {
    db.insert(t.auditEvents)
      .values({
        id: ulid(),
        invoiceId,
        actorType: actor.type,
        actorUserId: actor.type === 'user' ? actor.userId : null,
        event,
        fromState: states?.from ?? null,
        toState: states?.to ?? null,
        detailJson: JSON.stringify(detail),
        createdAt: this.now(),
      })
      .run();
  }

  /** A legal transition, with optimistic locking and its audit row, in the caller's transaction. */
  transition(
    db: Db,
    invoiceId: string,
    from: InvoiceState,
    to: InvoiceState,
    actor: Actor,
    patch: Partial<typeof t.invoices.$inferInsert> = {},
  ): void {
    assertTransition(from, to);
    const updated = db
      .update(t.invoices)
      .set({
        ...patch,
        state: to,
        stateVersion: sql`${t.invoices.stateVersion} + 1`,
        updatedAt: this.now(),
      })
      .where(and(eq(t.invoices.id, invoiceId), eq(t.invoices.state, from)))
      .run();
    if (updated.changes !== 1)
      throw new VeyraError('INVALID_STATE', `invoice ${invoiceId} is no longer ${from}`);
    this.audit(db, invoiceId, actor, 'invoice.state_changed', {}, { from, to });
  }

  invoiceRow(db: Db, invoiceId: string) {
    const row = db.select().from(t.invoices).where(eq(t.invoices.id, invoiceId)).get();
    if (!row) throw new VeyraError('NOT_FOUND', `invoice ${invoiceId} not found`);
    return row;
  }

  enqueue(db: Db, invoiceId: string, type: 'pipeline' | 'commit'): void {
    const pending = db
      .select()
      .from(t.jobs)
      .where(
        and(eq(t.jobs.invoiceId, invoiceId), eq(t.jobs.type, type), eq(t.jobs.status, 'queued')),
      )
      .get();
    if (pending) return;
    const now = this.now();
    db.insert(t.jobs)
      .values({
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
      })
      .run();
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  /**
   * Stores an uploaded invoice document and queues it. The file is untrusted: its type is decided
   * by its bytes, not its name or the browser's claim. An identical file (same SHA-256) is refused.
   */
  upload(file: { filename: string; bytes: Uint8Array }): { documentId: string; invoiceId: string } {
    const { bytes } = file;
    if (bytes.length === 0) throw new VeyraError('UNSUPPORTED_FILE', 'The file is empty.');
    if (bytes.length > MAX_UPLOAD_BYTES)
      throw new VeyraError('UNSUPPORTED_FILE', 'Files up to 20 MB are accepted.');
    const mime = sniffDocument(bytes);
    if (!mime) throw new VeyraError('UNSUPPORTED_FILE', 'Upload a PDF, JPEG or PNG invoice.');
    checkDocumentShape(bytes, mime);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = this.db.select().from(t.documents).where(eq(t.documents.sha256, sha256)).get();
    if (existing) {
      const inv = this.db
        .select({ id: t.invoices.id })
        .from(t.invoices)
        .where(eq(t.invoices.documentId, existing.id))
        .get();
      throw new VeyraError('DUPLICATE_UPLOAD', 'This exact file was already uploaded.', {
        documentId: existing.id,
        invoiceId: inv?.id ?? null,
      });
    }
    const documentId = ulid();
    const invoiceId = ulid();
    const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
    const storagePath = join(this.storageDir, `${documentId}.${ext}`);
    writeFileSync(storagePath, bytes);
    const filename = safeFilename(file.filename, ext);
    const userId = this.designatedUserId();
    const now = this.now();
    this.db.transaction((tx) => {
      tx.insert(t.documents)
        .values({
          id: documentId,
          sha256,
          filename,
          mime,
          sizeBytes: bytes.length,
          storagePath,
          uploadedByUserId: userId,
          uploadedAt: now,
        })
        .run();
      tx.insert(t.invoices)
        .values({
          id: invoiceId,
          documentId,
          state: 'UPLOADED',
          stateVersion: 1,
          runNo: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      this.audit(tx, invoiceId, { type: 'user', userId }, 'invoice.uploaded', {
        filename,
        mime,
        sizeBytes: bytes.length,
        sha256,
      });
      this.enqueue(tx, invoiceId, 'pipeline');
    });
    this.onEnqueue();
    return { documentId, invoiceId };
  }

  // ── Pipeline ─────────────────────────────────────────────────────────────

  /** Runs the pipeline job from wherever the invoice is. Safe to run twice: it no-ops when done. */
  async runPipeline(invoiceId: string): Promise<void> {
    let inv = this.invoiceRow(this.db, invoiceId);
    try {
      if (inv.state === 'UPLOADED') {
        this.transition(this.db, invoiceId, 'UPLOADED', 'EXTRACTING', { type: 'system' });
        inv = this.invoiceRow(this.db, invoiceId);
      }
      if (inv.state === 'EXTRACTING') {
        const ok = await this.extract(invoiceId);
        if (!ok) return;
        inv = this.invoiceRow(this.db, invoiceId);
      }
      if (inv.state === 'MATCHING') await this.evaluate(invoiceId);
    } catch (error) {
      this.fail(invoiceId, error);
    }
  }

  /** Moves an invoice in a system state to FAILED, recording where and why (never silently). */
  fail(invoiceId: string, error: unknown): void {
    const inv = this.invoiceRow(this.db, invoiceId);
    const systemStates: InvoiceState[] = [
      'UPLOADED',
      'EXTRACTING',
      'MATCHING',
      'RESOLVING',
      'VALIDATING',
      'COMMITTING',
    ];
    if (!systemStates.includes(inv.state as InvoiceState)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    this.db.transaction((tx) => {
      this.transition(
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
      this.audit(tx, invoiceId, { type: 'system' }, 'invoice.failed', {
        stage: inv.state,
        reason: reason.slice(0, 500),
      });
    });
  }

  /** READ. The extractor's output is untrusted: it is validated in full before anything uses it. */
  private async extract(invoiceId: string): Promise<boolean> {
    const doc = this.db
      .select()
      .from(t.documents)
      .innerJoin(t.invoices, eq(t.invoices.documentId, t.documents.id))
      .where(eq(t.invoices.id, invoiceId))
      .get()?.documents;
    if (!doc) throw new Error('document missing');
    let result: ExtractionResult;
    try {
      const raw: unknown = await this.extractor.extract({
        documentId: doc.id,
        filePath: doc.storagePath,
        mime: doc.mime,
        sha256: doc.sha256,
      });
      const parsed = ExtractionResultSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          `The extractor returned invalid data: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        );
      result = parsed.data;
    } catch (error) {
      this.fail(invoiceId, error);
      return false;
    }
    const extractionId = ulid();
    const now = this.now();
    this.db.transaction((tx) => {
      tx.insert(t.extractions)
        .values({
          id: extractionId,
          invoiceId,
          extractorId: result.extractor.id,
          extractorVersion: result.extractor.version,
          rawJson: JSON.stringify(result),
          createdAt: now,
        })
        .run();
      const human = new Set(
        tx
          .select({ path: t.extractedFields.path })
          .from(t.extractedFields)
          .where(
            and(
              eq(t.extractedFields.invoiceId, invoiceId),
              inArray(t.extractedFields.source, ['human_confirmed', 'human_corrected']),
            ),
          )
          .all()
          .map((r) => r.path),
      );
      const write = (
        path: FieldPath,
        f: { value: unknown; confidenceBp: number; evidence: unknown; source: string },
      ) => {
        if (human.has(path)) return; // human values are never overwritten by re-extraction
        tx.insert(t.extractedFields)
          .values({
            id: ulid(),
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
          })
          .onConflictDoUpdate({
            target: [t.extractedFields.invoiceId, t.extractedFields.path],
            set: {
              valueJson: JSON.stringify(f.value),
              confidenceBp: f.confidenceBp,
              evidenceJson: f.evidence ? JSON.stringify(f.evidence) : null,
              evidenceDetailJson: null,
              source: 'extracted',
              method: f.source,
              extractionId,
              updatedByUserId: null,
              updatedAt: now,
            },
          })
          .run();
      };
      for (const [key, f] of Object.entries(result.header))
        write(headerPath(key as HeaderFieldKey), f);
      for (const line of result.lines) {
        for (const [key, f] of Object.entries(line)) {
          if (key !== 'lineNo') write(linePath(line.lineNo, key as LineFieldKey), f as never);
        }
        tx.insert(t.invoiceLines)
          .values({ id: ulid(), invoiceId, lineNo: line.lineNo })
          .onConflictDoNothing()
          .run();
      }
      const lowConfidence = [
        ...Object.entries(result.header)
          .filter(([, f]) => f.value !== null && f.confidenceBp < this.settings(tx).confidenceMinBp)
          .map(([k]) => `header.${k}`),
      ];
      const read = [
        ...Object.values(result.header),
        ...result.lines.flatMap((l) => LINE_FIELD_KEYS.map((k) => l[k])),
      ];
      const methods = [...new Set(read.filter((f) => f.value !== null).map((f) => f.source))];
      this.audit(tx, invoiceId, { type: 'ai' }, 'extraction.completed', {
        extractor: result.extractor.id,
        extractorVersion: result.extractor.version,
        methods,
        lines: result.lines.length,
        pages: result.pages,
        lowConfidence,
        warnings: result.warnings,
      });
      this.transition(tx, invoiceId, 'EXTRACTING', 'MATCHING', { type: 'system' });
    });
    return true;
  }

  loadFields(db: Db, invoiceId: string): Map<string, StoredField> {
    const rows = db
      .select()
      .from(t.extractedFields)
      .where(eq(t.extractedFields.invoiceId, invoiceId))
      .all();
    return new Map(
      rows.map((r) => [
        r.path,
        {
          path: r.path as FieldPath,
          value: JSON.parse(r.valueJson) as JsonValue,
          confidenceBp: r.confidenceBp,
          source: r.source as FieldSource,
          evidence: r.evidenceJson ? JSON.parse(r.evidenceJson) : null,
          evidenceDetail: r.evidenceDetailJson ? JSON.parse(r.evidenceDetailJson) : null,
        },
      ]),
    );
  }

  answers(db: Db, invoiceId: string): AnsweredDecision[] {
    return db
      .select()
      .from(t.questions)
      .where(and(eq(t.questions.invoiceId, invoiceId), eq(t.questions.status, 'answered')))
      .all()
      .map((q) => {
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
    const settings = this.settings();
    const lineCount = this.db
      .select()
      .from(t.invoiceLines)
      .where(eq(t.invoiceLines.invoiceId, invoiceId))
      .all().length;
    return runEngine({
      invoiceId,
      today: this.today(),
      settings,
      fields: this.loadFields(this.db, invoiceId),
      lineCount,
      answers: this.answers(this.db, invoiceId),
      existingActions: this.db
        .select({
          id: t.creationActions.id,
          signature: t.creationActions.signature,
          status: t.creationActions.status,
        })
        .from(t.creationActions)
        .where(eq(t.creationActions.invoiceId, invoiceId))
        .all() as { id: string; signature: string; status: 'staged' | 'committed' | 'discarded' }[],
      erp: this.erp,
      otherInvoicesWithKey: async (key) =>
        this.db
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
          .all()
          .map((o) => {
            const f = this.loadFields(this.db, o.id);
            const date = readField<string>(f, 'header.invoiceDate', 0).value;
            const total = readField<number>(f, 'header.totalPaise', 0).value;
            return { id: o.id, state: o.state, invoiceDate: date, totalPaise: total };
          }),
      newId: ulid,
    });
  }

  /** MATCHING → RESOLVING → VALIDATING → NEEDS_INPUT | COMMITTING | FAILED, persisted atomically. */
  private async evaluate(invoiceId: string): Promise<void> {
    const out = await this.engine(invoiceId);
    const now = this.now();
    let queuedCommit = false;
    this.db.transaction((tx) => {
      const inv = this.invoiceRow(tx, invoiceId);
      if (inv.state !== 'MATCHING') return; // another run got here first
      const runNo = inv.runNo + 1;
      const sys: Actor = { type: 'system' };

      // FIND
      for (const m of out.matches) {
        tx.insert(t.matchResults)
          .values({
            id: ulid(),
            invoiceId,
            runNo,
            entity: m.entity,
            lineNo: m.lineNo,
            outcome: m.outcome,
            method: m.method,
            candidatesJson: JSON.stringify(m.candidates),
            chosenErpId: m.chosenErpId,
          })
          .run();
      }
      for (const f of out.derivedFields) {
        tx.insert(t.extractedFields)
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
          })
          .run();
        this.audit(tx, invoiceId, sys, 'field.derived', {
          path: f.path,
          value: f.value,
          source: f.source,
          detail: f.evidenceDetail,
        });
      }
      this.audit(tx, invoiceId, sys, 'match.recorded', {
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
      this.transition(tx, invoiceId, 'MATCHING', 'RESOLVING', sys, {
        runNo,
        vendorErpId: out.vendor?.kind === 'erp' ? out.vendor.id : null,
        poErpId: out.po?.kind === 'erp' ? out.po.id : null,
      });

      // USE / IF MISSING, CREATE (staged; nothing reaches the ERP yet)
      const existing = tx
        .select()
        .from(t.creationActions)
        .where(eq(t.creationActions.invoiceId, invoiceId))
        .all();
      const planned = new Set(out.actions.map((a) => a.id));
      for (const a of out.actions) {
        if (existing.some((e) => e.id === a.id)) continue;
        tx.insert(t.creationActions)
          .values({
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
          })
          .run();
        this.audit(
          tx,
          invoiceId,
          a.trigger === 'user_approval' ? { type: 'user', userId: a.approvedByUserId ?? '' } : sys,
          a.trigger === 'user_approval' ? 'creation.approved' : 'creation.staged',
          { actionId: a.id, entity: a.entity, policyCode: a.policyCode, payload: a.payload },
        );
      }
      for (const e of existing) {
        if (e.status === 'staged' && !planned.has(e.id)) {
          tx.update(t.creationActions)
            .set({ status: 'discarded' })
            .where(eq(t.creationActions.id, e.id))
            .run();
          this.audit(tx, invoiceId, sys, 'creation.discarded', {
            actionId: e.id,
            entity: e.entity,
            reason: 'no longer needed',
          });
        }
      }
      for (const line of out.lines) {
        tx.update(t.invoiceLines)
          .set({
            itemErpId: line.item?.kind === 'erp' ? line.item.id : null,
            itemRefStagedActionId: line.item?.kind === 'staged' ? line.item.actionId : null,
            poLineErpId: line.poLine?.kind === 'erp' ? line.poLine.id : null,
          })
          .where(
            and(eq(t.invoiceLines.invoiceId, invoiceId), eq(t.invoiceLines.lineNo, line.lineNo)),
          )
          .run();
      }
      this.transition(tx, invoiceId, 'RESOLVING', 'VALIDATING', sys);

      // VALIDATE
      for (const r of out.validations) {
        tx.insert(t.validationResults)
          .values({
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
          })
          .run();
      }
      const failed = out.validations
        .filter((r) => r.outcome === 'fail')
        .map((r) => (r.lineNo ? `${r.ruleCode}:line:${r.lineNo}` : r.ruleCode));
      this.audit(tx, invoiceId, sys, 'validation.completed', {
        runNo,
        passed: out.validations.filter((r) => r.outcome === 'pass').length,
        failed,
        notApplicable: out.validations
          .filter((r) => r.outcome === 'not_applicable')
          .map((r) => `${r.ruleCode}:${r.naReason}`),
        notEvaluated: out.validations.filter((r) => r.outcome === 'not_evaluated').length,
      });
      this.syncQuestions(tx, invoiceId, out.questions);
      const dup = out.duplicateKey;
      const patch = {
        dupVendorGstin: dup?.vendorGstin ?? null,
        dupInvoiceNo: dup?.invoiceNoNormalized ?? null,
        dupFy: dup?.fy ?? null,
      };

      // ASK, or COMMIT automatically (there is no human "verify" step)
      if (out.questions.length > 0) {
        this.transition(tx, invoiceId, 'VALIDATING', 'NEEDS_INPUT', sys, patch);
      } else if (out.plan) {
        this.transition(tx, invoiceId, 'VALIDATING', 'COMMITTING', sys, {
          ...patch,
          commitPlanJson: JSON.stringify(out.plan),
        });
        this.enqueue(tx, invoiceId, 'commit');
        queuedCommit = true;
      } else {
        // Safety net (RULES §4): a failed or unevaluated rule with no question is never passed.
        this.transition(tx, invoiceId, 'VALIDATING', 'FAILED', sys, {
          ...patch,
          failedStage: 'VALIDATING',
          failureReason: 'INVARIANT_VIOLATION: a check did not pass but no question was raised.',
        });
        this.audit(tx, invoiceId, sys, 'invoice.failed', {
          stage: 'VALIDATING',
          reason: 'INVARIANT_VIOLATION',
          rules: failed,
        });
      }
    });
    if (queuedCommit) this.onEnqueue();
  }

  /** Questions are idempotent by (code, subject): keep what is still asked, supersede the rest. */
  private syncQuestions(tx: VeyraTx, invoiceId: string, drafts: readonly QuestionDraft[]): void {
    const open = tx
      .select()
      .from(t.questions)
      .where(and(eq(t.questions.invoiceId, invoiceId), eq(t.questions.status, 'open')))
      .all();
    const userId = this.settings(tx).designatedUserId;
    const now = this.now();
    for (const q of open) {
      if (!drafts.some((d) => d.code === q.code && d.subjectKey === q.subjectKey)) {
        tx.update(t.questions).set({ status: 'superseded' }).where(eq(t.questions.id, q.id)).run();
        this.audit(tx, invoiceId, { type: 'system' }, 'question.superseded', {
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
        tx.update(t.questions).set(values).where(eq(t.questions.id, current.id)).run();
        continue;
      }
      const id = ulid();
      tx.insert(t.questions)
        .values({
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
        })
        .run();
      this.audit(tx, invoiceId, { type: 'system' }, 'question.raised', {
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
  answer(questionId: string, body: { optionId: string; input: unknown }, userId: string): void {
    if (userId !== this.designatedUserId())
      throw new VeyraError('NOT_DESIGNATED_USER', 'Only the designated user can answer questions.');
    const q = this.db.select().from(t.questions).where(eq(t.questions.id, questionId)).get();
    if (!q) throw new VeyraError('NOT_FOUND', 'Question not found.');
    if (q.status !== 'open')
      throw new VeyraError('INVALID_STATE', 'This question has already been answered.');
    const inv = this.invoiceRow(this.db, q.invoiceId);
    if (inv.state !== 'NEEDS_INPUT')
      throw new VeyraError('INVALID_STATE', 'This invoice is not waiting for an answer.');
    const options = JSON.parse(q.optionsJson) as {
      id: string;
      label: string;
      effect: AnswerEffect;
    }[];
    const option = options.find((o) => o.id === body.optionId);
    if (!option) throw new VeyraError('INVALID_INPUT', 'That is not one of the options.');
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

    this.db.transaction((tx) => {
      const seq =
        (tx
          .select({ m: max(t.questions.answerSeq) })
          .from(t.questions)
          .get()?.m ?? 0) + 1;
      tx.update(t.questions)
        .set({
          status: 'answered',
          answerJson: JSON.stringify({ optionId: option.id, input: parsed.value, effect }),
          answeredByUserId: userId,
          answeredAt: now,
          answerSeq: seq,
        })
        .where(and(eq(t.questions.id, q.id), eq(t.questions.status, 'open')))
        .run();
      this.audit(tx, q.invoiceId, user, 'question.answered', {
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
        const fields = this.loadFields(tx, q.invoiceId);
        const current = fields.get(path);
        const value = effect.type === 'SET_FIELD' ? parsed.value : (current?.value ?? null);
        const source: FieldSource =
          effect.type === 'SET_FIELD' ? 'human_corrected' : 'human_confirmed';
        tx.insert(t.extractedFields)
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
          })
          .run();
        this.audit(
          tx,
          q.invoiceId,
          user,
          effect.type === 'SET_FIELD' ? 'field.corrected' : 'field.confirmed',
          { path, from: current?.value ?? null, to: value },
        );
      }

      if (effect.type === 'REJECT_INVOICE') {
        this.rejectInTx(tx, q.invoiceId, 'NEEDS_INPUT', userId, option.label);
        return;
      }
      this.transition(tx, q.invoiceId, 'NEEDS_INPUT', 'MATCHING', user);
      this.enqueue(tx, q.invoiceId, 'pipeline');
    });
    this.onEnqueue();
  }

  private rejectInTx(
    tx: VeyraTx,
    invoiceId: string,
    from: InvoiceState,
    userId: string,
    reason: string,
  ): void {
    const user: Actor = { type: 'user', userId };
    this.transition(tx, invoiceId, from, 'REJECTED', user, {
      rejectedByUserId: userId,
      rejectedReason: reason,
      commitPlanJson: null,
    });
    this.audit(tx, invoiceId, user, 'invoice.rejected', { reason });
    // D1: staged records never reach the ERP; a confirmed GRN stays here, discarded, for the audit trail.
    const staged = tx
      .select()
      .from(t.creationActions)
      .where(
        and(eq(t.creationActions.invoiceId, invoiceId), eq(t.creationActions.status, 'staged')),
      )
      .all();
    for (const a of staged) {
      tx.update(t.creationActions)
        .set({ status: 'discarded' })
        .where(eq(t.creationActions.id, a.id))
        .run();
      this.audit(tx, invoiceId, { type: 'system' }, 'creation.discarded', {
        actionId: a.id,
        entity: a.entity,
        reason: 'invoice rejected',
        payload: JSON.parse(a.payloadJson),
      });
    }
    const open = tx
      .select()
      .from(t.questions)
      .where(and(eq(t.questions.invoiceId, invoiceId), eq(t.questions.status, 'open')))
      .all();
    for (const q of open) {
      tx.update(t.questions).set({ status: 'superseded' }).where(eq(t.questions.id, q.id)).run();
    }
  }

  /** Explicit business rejection by the designated user (from NEEDS_INPUT or FAILED). */
  reject(invoiceId: string, reason: string, userId: string): void {
    if (userId !== this.designatedUserId())
      throw new VeyraError('NOT_DESIGNATED_USER', 'Only the designated user can reject invoices.');
    const inv = this.invoiceRow(this.db, invoiceId);
    if (inv.state !== 'NEEDS_INPUT' && inv.state !== 'FAILED')
      throw new VeyraError('INVALID_STATE', 'Only invoices waiting for you can be rejected.');
    this.db.transaction((tx) =>
      this.rejectInTx(tx, invoiceId, inv.state as InvoiceState, userId, reason),
    );
  }

  /** FAILED → EXTRACTING (extraction never finished) or MATCHING (re-run on the stored reading). */
  reprocess(invoiceId: string, userId: string): void {
    if (userId !== this.designatedUserId())
      throw new VeyraError(
        'NOT_DESIGNATED_USER',
        'Only the designated user can reprocess invoices.',
      );
    const inv = this.invoiceRow(this.db, invoiceId);
    if (inv.state !== 'FAILED')
      throw new VeyraError('INVALID_STATE', 'Only failed invoices can be processed again.');
    const extracted = this.db
      .select()
      .from(t.extractions)
      .where(eq(t.extractions.invoiceId, invoiceId))
      .get();
    const to: InvoiceState =
      extracted && inv.failedStage !== 'EXTRACTING' && inv.failedStage !== 'UPLOADED'
        ? 'MATCHING'
        : 'EXTRACTING';
    this.db.transaction((tx) => {
      this.transition(
        tx,
        invoiceId,
        'FAILED',
        to,
        { type: 'user', userId },
        { failedStage: null, failureReason: null },
      );
      this.enqueue(tx, invoiceId, 'pipeline');
    });
    this.onEnqueue();
  }

  // ── Commit ───────────────────────────────────────────────────────────────

  /** COMMITTING (decision D4): automatic, restartable, idempotent. See ./commit.ts. */
  async runCommit(invoiceId: string): Promise<void> {
    const inv = this.invoiceRow(this.db, invoiceId);
    if (inv.state !== 'COMMITTING') return;
    await executeCommit(this, invoiceId, JSON.parse(inv.commitPlanJson ?? 'null') as CommitPlan);
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  /** After a restart, jobs that were running are queued again. Every job is safe to re-run. */
  recoverJobs(): number {
    return this.db
      .update(t.jobs)
      .set({ status: 'queued', lockedAt: null, updatedAt: this.now() })
      .where(eq(t.jobs.status, 'running'))
      .run().changes;
  }

  claimJob(): {
    id: string;
    invoiceId: string;
    type: 'pipeline' | 'commit';
    attempts: number;
  } | null {
    return this.db.transaction((tx) => {
      const job = tx
        .select()
        .from(t.jobs)
        .where(and(eq(t.jobs.status, 'queued'), lte(t.jobs.runAfter, this.now())))
        .orderBy(asc(t.jobs.createdAt), asc(t.jobs.id))
        .get();
      if (!job) return null;
      tx.update(t.jobs)
        .set({
          status: 'running',
          lockedAt: this.now(),
          attempts: job.attempts + 1,
          updatedAt: this.now(),
        })
        .where(eq(t.jobs.id, job.id))
        .run();
      return {
        id: job.id,
        invoiceId: job.invoiceId,
        type: job.type as 'pipeline' | 'commit',
        attempts: job.attempts + 1,
      };
    });
  }

  finishJob(
    id: string,
    outcome:
      | { status: 'succeeded' }
      | { status: 'failed'; error: string }
      | { status: 'retry'; error: string; delayMs: number },
  ): void {
    const now = this.clock().getTime();
    this.db
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
      .where(eq(t.jobs.id, id))
      .run();
  }

  pendingJobs(): number {
    return this.db
      .select()
      .from(t.jobs)
      .where(inArray(t.jobs.status, ['queued', 'running']))
      .all().length;
  }

  latestJobs(invoiceId: string) {
    return this.db
      .select()
      .from(t.jobs)
      .where(eq(t.jobs.invoiceId, invoiceId))
      .orderBy(desc(t.jobs.createdAt))
      .all();
  }
}

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
