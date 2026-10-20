import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { ExtractionResultSchema } from '@veyra/shared';
import { ExtractorError, sniffDocument, type Extractor } from '@veyra/extractor';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';
import { ulid } from '../ids';
import { sha256Hex, type DocumentStorage } from '../storage';
import {
  ReceiptFileSchema,
  normalizeReceipt,
  receiptComparison,
  type ReceiptRecord,
} from '../workflow/erp-receipts';
import { fieldsFromExtraction, invoiceSideFrom } from '../workflow/invoice-side';
import { isRetryable, safeErrorCode } from '../workflow/retry';
import { VeyraError, checkDocumentShape, uploadLimitText } from '../workflow/veyra';
import type { ApiClient } from './clients';
import { verificationOutcome, type Outcome, type VerificationOutcome } from './result';

/**
 * The Client Invoice Verification API's work (docs/VERIFY-API.md): a client submits an invoice and
 * its own reference record; Veyrafy reads the invoice itself (the configured reader, as for any
 * upload) and compares what it read with the reference (`receiptComparison`, the receipt check's
 * logic). The reference is never taken as proof of what the invoice says.
 *
 * Asynchronous: the submission is stored and answered at once (202); the reading runs in the job
 * runner's loop. Each verification row is its own unit of work, claimed with a lease, so a
 * restart or a crash never loses or duplicates one. The invoice file is kept in (encrypted)
 * document storage only until it has been read, then deleted.
 */

/** A request the API refuses, with its HTTP status and a stable code (never content). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const REFERENCE_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
/** The reference record itself, without the invoice file it may carry (`images`). */
const MAX_REFERENCE_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;

/**
 * The largest request body the submit route accepts: the invoice as base64 (4 characters per 3
 * bytes) inside the reference, plus the reference itself and room for the JSON around them.
 */
export function maxSubmitBytes(maxUploadBytes: number): number {
  return Math.ceil(maxUploadBytes / 3) * 4 + MAX_REFERENCE_BYTES + 64 * 1024;
}

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

export interface VerifyOptions {
  db: VeyraDb;
  storage: DocumentStorage;
  extractor: Extractor;
  now: () => string;
  maxUploadBytes: number;
  /** The confidence below which a value counts as not read (the instance's setting). */
  minConfidenceBp: () => Promise<number>;
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

export interface VerificationView {
  verification_id: string;
  reference_id: string;
  processing_status: 'processing' | 'completed' | 'error' | 'deleted';
  status: Outcome | null;
  review_required: boolean | null;
  scope: string;
  checks: VerificationOutcome['checks'];
  failed_fields: VerificationOutcome['failed_fields'];
  unverified_fields: VerificationOutcome['unverified_fields'];
  error: { code: string; message: string } | null;
  created_at: string;
  completed_at: string | null;
}

/** What a processing failure means for the client (codes are stable; never the cause's detail). */
const ERROR_TEXT: Record<string, string> = {
  DOCUMENT_UNREADABLE: 'The invoice could not be read: no text was found, even by OCR.',
  MULTIPLE_INVOICES: 'The file holds more than one invoice. Submit each invoice on its own.',
  UNSUPPORTED_DOCUMENT: 'The file could not be read as an invoice (unsupported or damaged).',
  PROCESSING_FAILED: 'Veyrafy could not complete this verification. Submit it again later.',
};

export class VerificationService {
  constructor(private readonly o: VerifyOptions) {}

  /**
   * Validates and stores a submission (nothing is read yet). The same submission sent again (same
   * Idempotency-Key, or the same reference id, invoice and reference when no key is sent) returns
   * the verification already made; a key reused for a different submission is refused.
   */
  async submit(
    client: ApiClient,
    input: {
      referenceId: unknown;
      /** The reference: JSON text (a multipart field) or the already parsed body of a JSON request. */
      reference: unknown;
      /** The invoice as a file part; without one, the invoice is taken from the reference's `images`. */
      invoice: { bytes: Uint8Array } | null;
      idempotencyKey: string | undefined;
    },
  ): Promise<{ view: VerificationView; replayed: boolean }> {
    const referenceId = typeof input.referenceId === 'string' ? input.referenceId.trim() : '';
    if (!REFERENCE_ID.test(referenceId))
      throw new ApiRequestError(
        400,
        'INVALID_REQUEST',
        'reference_id is required: 1–128 characters (letters, digits and . _ : / -).',
        { field: 'reference_id' },
      );
    if (input.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(input.idempotencyKey))
      throw new ApiRequestError(
        400,
        'INVALID_REQUEST',
        'Idempotency-Key must be 1–128 characters (letters, digits and . _ : -).',
        { field: 'Idempotency-Key' },
      );
    const { record, images } = this.reference(input.reference);
    const bytes = input.invoice?.bytes ?? this.invoiceFromImages(images);
    if (bytes.length === 0) throw new VeyraError('UNSUPPORTED_FILE', 'The invoice file is empty.');
    if (bytes.length > this.o.maxUploadBytes)
      throw new ApiRequestError(
        413,
        'TOO_LARGE',
        `Files up to ${uploadLimitText(this.o.maxUploadBytes)} are accepted.`,
      );
    const mime = sniffDocument(bytes);
    if (!mime)
      throw new VeyraError('UNSUPPORTED_FILE', 'The invoice must be a PDF, JPEG or PNG file.');
    checkDocumentShape(bytes, mime);

    const documentSha256 = sha256Hex(bytes);
    const referenceJson = JSON.stringify(record);
    const requestHash = createHash('sha256')
      .update(`${referenceId}\u0000${documentSha256}\u0000${referenceJson}`)
      .digest('hex');
    const idempotencyKey = input.idempotencyKey ?? `auto:${requestHash}`;

    const existing = await this.byKey(client.id, idempotencyKey);
    if (existing) return this.replay(existing, requestHash);

    const id = ulid();
    const storageKey = `verifications/${id}`;
    const now = this.o.now();
    await this.o.storage.put(storageKey, bytes, { mime, sha256: documentSha256 });
    try {
      await this.o.db.transaction(async (tx) => {
        await tx.insert(t.verifications).values({
          id,
          clientId: client.id,
          referenceId,
          idempotencyKey,
          requestHash,
          documentSha256,
          mime,
          sizeBytes: bytes.length,
          storageKey,
          referenceJson,
          processingStatus: 'processing',
          attempts: 0,
          runAfter: now,
          createdAt: now,
        });
        await this.audit(tx, 'verify.submitted', {
          verificationId: id,
          clientId: client.id,
          sizeBytes: bytes.length,
          mime,
        });
      });
    } catch (error) {
      await this.o.storage.delete(storageKey).catch(() => undefined);
      // Two identical requests at once: the second finds the first's row.
      const raced = await this.byKey(client.id, idempotencyKey);
      if (raced) return this.replay(raced, requestHash);
      throw error;
    }
    const row = await this.row(client.id, id);
    if (!row) throw new Error('verification not stored');
    return { view: this.view(row), replayed: false };
  }

  /**
   * The reference record: a goods-receipt export with exactly one record. Its `images` (where the
   * client's system keeps the invoice file, as base64) are returned apart and never stored with it.
   */
  private reference(raw: unknown): { record: ReceiptRecord; images: { base64: string }[] } {
    let json: unknown = raw;
    if (typeof raw === 'string') {
      if (raw.trim() === '')
        throw new ApiRequestError(400, 'INVALID_REFERENCE', 'reference_json is required.', {
          field: 'reference_json',
        });
      try {
        json = JSON.parse(raw);
      } catch {
        throw new ApiRequestError(400, 'INVALID_REFERENCE', 'reference_json is not valid JSON.', {
          field: 'reference_json',
        });
      }
    } else if (raw === undefined || raw === null) {
      throw new ApiRequestError(400, 'INVALID_REFERENCE', 'The reference record is required.', {
        field: 'reference_json',
      });
    }
    const parsed = ReceiptFileSchema.safeParse(json);
    if (!parsed.success)
      throw new ApiRequestError(
        400,
        'INVALID_REFERENCE',
        'The reference is not a record Veyrafy recognises (docs/VERIFY-API.md).',
        // Where it does not fit, never the values.
        {
          field: 'reference_json',
          issues: parsed.error.issues
            .slice(0, 10)
            .map((i) => ({ path: i.path.join('.'), problem: i.code })),
        },
      );
    if (parsed.data.data.length !== 1)
      throw new ApiRequestError(
        400,
        'INVALID_REFERENCE',
        'The reference must hold exactly one record in "data" (one invoice per request).',
        { field: 'reference_json.data' },
      );
    const first = parsed.data.data[0];
    if (!first) throw new ApiRequestError(400, 'INVALID_REFERENCE', 'The reference is empty.');
    const { images, ...rest } = first;
    if (Buffer.byteLength(JSON.stringify(rest), 'utf8') > MAX_REFERENCE_BYTES)
      throw new ApiRequestError(
        413,
        'TOO_LARGE',
        'The reference record (without its images) is larger than 1 MB.',
        { field: 'reference_json' },
      );
    return { record: normalizeReceipt(first), images: images ?? [] };
  }

  /** The invoice file sent inside the reference, as base64 (exactly one file). */
  private invoiceFromImages(images: { base64: string }[]): Uint8Array {
    if (images.length === 0)
      throw new ApiRequestError(
        400,
        'INVALID_REQUEST',
        'Send the invoice as base64 in the record\'s "images", or as the "invoice" file part.',
        { field: 'invoice' },
      );
    if (images.length > 1)
      throw new ApiRequestError(
        400,
        'INVALID_REQUEST',
        `"images" holds ${images.length} files. Send only the invoice, or send it as the "invoice" file part.`,
        { field: 'images', count: images.length },
      );
    // A data URL's prefix and any line breaks are allowed; the content must be base64 throughout.
    const text = (images[0]?.base64 ?? '').replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
    if (!BASE64.test(text) || text.length % 4 === 1)
      throw new ApiRequestError(400, 'INVALID_REQUEST', 'images[0].base64 is not valid base64.', {
        field: 'images[0].base64',
      });
    if (Math.floor((text.length * 3) / 4) > this.o.maxUploadBytes + 2)
      throw new ApiRequestError(
        413,
        'TOO_LARGE',
        `Files up to ${uploadLimitText(this.o.maxUploadBytes)} are accepted.`,
        { field: 'images[0].base64' },
      );
    return new Uint8Array(Buffer.from(text, 'base64'));
  }

  private replay(row: typeof t.verifications.$inferSelect, requestHash: string) {
    if (row.requestHash !== requestHash)
      throw new ApiRequestError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used for a different request.',
      );
    return { view: this.view(row), replayed: true };
  }

  private async byKey(clientId: string, key: string) {
    const [row] = await this.o.db
      .select()
      .from(t.verifications)
      .where(and(eq(t.verifications.clientId, clientId), eq(t.verifications.idempotencyKey, key)))
      .limit(1);
    return row ?? null;
  }

  private async row(clientId: string, id: string) {
    const [row] = await this.o.db
      .select()
      .from(t.verifications)
      .where(and(eq(t.verifications.id, id), eq(t.verifications.clientId, clientId)))
      .limit(1);
    return row ?? null;
  }

  /** A client's own verification; null for anyone else's (never told apart from "not found"). */
  async get(clientId: string, id: string): Promise<VerificationView | null> {
    const row = await this.row(clientId, id);
    return row ? this.view(row) : null;
  }

  /**
   * Deletes a verification's data (the client's choice, or its retention policy): the invoice
   * file if it is still stored, the reference and the result. A record of the request remains
   * (ids, times, hashes), and the deletion is audited.
   */
  async delete(clientId: string, id: string): Promise<boolean> {
    const row = await this.row(clientId, id);
    if (!row || row.processingStatus === 'deleted') return false;
    if (row.storageKey) await this.o.storage.delete(row.storageKey);
    await this.o.db.transaction(async (tx) => {
      await tx
        .update(t.verifications)
        .set({
          processingStatus: 'deleted',
          status: null,
          storageKey: null,
          referenceJson: null,
          resultJson: null,
          lockedAt: null,
          deletedAt: this.o.now(),
        })
        .where(eq(t.verifications.id, id));
      await this.audit(tx, 'verify.deleted', { verificationId: id, clientId });
    });
    return true;
  }

  private view(row: typeof t.verifications.$inferSelect): VerificationView {
    const result = row.resultJson ? (JSON.parse(row.resultJson) as VerificationOutcome) : null;
    const status = row.processingStatus as VerificationView['processing_status'];
    return {
      verification_id: row.id,
      reference_id: row.referenceId,
      processing_status: status,
      status: (row.status as Outcome | null) ?? null,
      review_required: result ? result.review_required : null,
      scope: result?.scope ?? 'invoice_vs_reference',
      checks: result?.checks ?? [],
      failed_fields: result?.failed_fields ?? [],
      unverified_fields: result?.unverified_fields ?? [],
      error:
        status === 'error'
          ? {
              code: row.errorCode ?? 'PROCESSING_FAILED',
              message: ERROR_TEXT[row.errorCode ?? ''] ?? ERROR_TEXT.PROCESSING_FAILED ?? '',
            }
          : null,
      created_at: row.createdAt,
      completed_at: row.completedAt,
    };
  }

  // ── Processing (called by the job runner's loop when it has no invoice job) ──

  /** Processes one waiting verification. Returns false when there is none. */
  async processNext(): Promise<boolean> {
    const now = this.o.now();
    const stale = new Date(Date.parse(now) - LEASE_MS).toISOString();
    const claimed = await this.o.db.transaction(async (tx) => {
      const [next] = await tx
        .select({ id: t.verifications.id, attempts: t.verifications.attempts })
        .from(t.verifications)
        .where(
          and(
            eq(t.verifications.processingStatus, 'processing'),
            lte(t.verifications.runAfter, now),
            or(isNull(t.verifications.lockedAt), lte(t.verifications.lockedAt, stale)),
          ),
        )
        .orderBy(asc(t.verifications.runAfter), asc(t.verifications.seq))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!next) return null;
      await tx
        .update(t.verifications)
        .set({ lockedAt: now, attempts: sql`${t.verifications.attempts} + 1` })
        .where(eq(t.verifications.id, next.id));
      return { id: next.id, attempts: next.attempts + 1 };
    });
    if (!claimed) return false;
    try {
      await this.process(claimed.id);
    } catch (error) {
      await this.failed(claimed.id, claimed.attempts, error);
    }
    return true;
  }

  private async process(id: string): Promise<void> {
    const [row] = await this.o.db
      .select()
      .from(t.verifications)
      .where(eq(t.verifications.id, id))
      .limit(1);
    if (!row || row.processingStatus !== 'processing' || !row.storageKey || !row.referenceJson)
      return;
    const started = Date.now();
    const bytes = await this.o.storage.get(row.storageKey, { sha256: row.documentSha256 });
    const reading = ExtractionResultSchema.parse(
      await this.o.extractor.extract({
        documentId: row.id,
        bytes,
        mime: row.mime,
        sha256: row.documentSha256,
      }),
    );
    const min = await this.o.minConfidenceBp();
    const inv = invoiceSideFrom(
      fieldsFromExtraction(reading),
      reading.lines.map((l) => l.lineNo),
      reading.otherFields ?? [],
      min,
    );
    const record = JSON.parse(row.referenceJson) as ReceiptRecord;
    const { rows, totalDeltaPaise } = receiptComparison(inv, record);
    const outcome = verificationOutcome(rows, inv, totalDeltaPaise);
    const now = this.o.now();
    await this.o.db.transaction(async (tx) => {
      await tx
        .update(t.verifications)
        .set({
          processingStatus: 'completed',
          status: outcome.status,
          resultJson: JSON.stringify(outcome),
          storageKey: null,
          lockedAt: null,
          completedAt: now,
        })
        .where(and(eq(t.verifications.id, id), eq(t.verifications.processingStatus, 'processing')));
      await this.audit(tx, 'verify.completed', {
        verificationId: id,
        clientId: row.clientId,
        status: outcome.status,
        failed: outcome.failed_fields.length,
        unverified: outcome.unverified_fields.length,
      });
    });
    // The invoice was only needed to be read: it is not kept.
    await this.o.storage.delete(row.storageKey).catch(() => undefined);
    this.o.log?.info(
      {
        verificationId: id,
        status: outcome.status,
        checks: outcome.checks.length,
        durationMs: Date.now() - started,
      },
      'verification completed',
    );
  }

  /**
   * A temporary failure (storage, database) is tried again with a growing wait; anything else, or
   * the last attempt, ends the verification as a processing error, never as FAILED.
   */
  private async failed(id: string, attempts: number, error: unknown): Promise<void> {
    if (isRetryable(error) && attempts < MAX_ATTEMPTS) {
      const wait = attempts * 1000;
      await this.o.db
        .update(t.verifications)
        .set({
          lockedAt: null,
          runAfter: new Date(Date.parse(this.o.now()) + wait).toISOString(),
        })
        .where(eq(t.verifications.id, id));
      return;
    }
    const code =
      error instanceof ExtractorError
        ? error.code === 'MULTIPLE_INVOICES'
          ? 'MULTIPLE_INVOICES'
          : error.code === 'MALFORMED_DOCUMENT'
            ? 'DOCUMENT_UNREADABLE'
            : 'UNSUPPORTED_DOCUMENT'
        : 'PROCESSING_FAILED';
    const [row] = await this.o.db
      .select()
      .from(t.verifications)
      .where(eq(t.verifications.id, id))
      .limit(1);
    await this.o.db.transaction(async (tx) => {
      await tx
        .update(t.verifications)
        .set({
          processingStatus: 'error',
          errorCode: code,
          storageKey: null,
          lockedAt: null,
          completedAt: this.o.now(),
        })
        .where(and(eq(t.verifications.id, id), eq(t.verifications.processingStatus, 'processing')));
      await this.audit(tx, 'verify.error', { verificationId: id, code });
    });
    if (row?.storageKey) await this.o.storage.delete(row.storageKey).catch(() => undefined);
    this.o.log?.warn(
      { verificationId: id, code, cause: safeErrorCode(error) },
      'verification could not be processed',
    );
  }

  private async audit(
    db: Pick<VeyraDb, 'insert'>,
    event: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await db.insert(t.auditEvents).values({
      id: ulid(),
      invoiceId: null,
      actorType: 'system',
      actorUserId: null,
      event,
      fromState: null,
      toState: null,
      // Ids, counts and codes only: never invoice or reference content.
      detailJson: JSON.stringify(detail),
      createdAt: this.o.now(),
    });
  }
}
