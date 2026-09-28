import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { and, desc, eq, ne } from 'drizzle-orm';
import { importIdempotencyKey, type ApiImport } from '@veyra/shared';
import { isErpConnectorError, type ImportBusinessRecordsResult } from '@veyra/erp-connector';
import * as t from '../db/schema';
import { ulid } from '../ids';
import { VeyraError, type Veyra } from '../workflow/veyra';
import {
  checkImport,
  erpSnapshot,
  type ErpSnapshot,
  type ImportCheck,
  type UploadedFile,
} from './validate';

type ImportRow = typeof t.imports.$inferSelect;
interface StoredFile {
  filename: string;
  /** Storage key (Phase 6). */
  key?: string;
  /** Before Phase 6: the absolute path under the uploads folder. */
  path?: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Importing business records (Phase 3C): upload → validate → preview → confirm.
 *
 * Validation reads the ERP only through ErpConnector. Confirmation re-validates against the ERP
 * as it is at that moment and then writes through ErpConnector.importBusinessRecords: one atomic,
 * idempotent write (key `veyra:import:<id>`), so a retried confirmation never duplicates records
 * and a failure leaves the ERP unchanged. Nothing here touches ERP storage directly.
 */
export class BusinessImports {
  constructor(readonly veyra: Veyra) {}

  /** Storage key of a stored upload file (rows from before Phase 6 kept an absolute path). */
  private keyOf(id: string, f: StoredFile): string {
    return f.key ?? `imports/${id}/${basename(f.path ?? '')}`;
  }

  snapshot(): Promise<ErpSnapshot> {
    return erpSnapshot(this.veyra.erp);
  }

  private async run(files: readonly UploadedFile[]): Promise<ImportCheck> {
    return checkImport(files, await this.snapshot(), this.veyra.today());
  }

  /** Validates an upload and stores it with its preview. Nothing is imported yet. */
  async check(files: readonly UploadedFile[], userId: string): Promise<ApiImport> {
    await this.requireDesignated(userId);
    const id = ulid();
    const stored: StoredFile[] = [];
    for (const [i, f] of files.entries()) {
      const safe =
        (f.filename.split(/[\\/]/).pop() ?? 'file')
          .replace(/[^\w.\- ()]/g, '_')
          .replace(/\.{2,}/g, '.')
          .slice(0, 120)
          .trim() || 'file';
      const key = `imports/${id}/${i + 1}-${safe}`;
      const sha256 = createHash('sha256').update(f.bytes).digest('hex');
      await this.veyra.storage.put(key, f.bytes, { mime: 'application/octet-stream', sha256 });
      stored.push({ filename: safe, key, sha256, sizeBytes: f.bytes.length });
    }
    const check = await this.run(
      files.map((f, i) => ({ filename: stored[i]?.filename ?? f.filename, bytes: f.bytes })),
    );
    const now = this.veyra.now();
    const kinds = check.tables.map((x) => x.label).join(', ') || 'No records';
    await this.veyra.db.transaction(async (tx) => {
      await tx.insert(t.imports).values({
        id,
        filesJson: JSON.stringify(stored),
        kinds,
        status: check.errors.length ? 'invalid' : 'ready',
        checkJson: JSON.stringify(check),
        resultJson: null,
        uploadedByUserId: userId,
        confirmedByUserId: null,
        createdAt: now,
        confirmedAt: null,
      });
      await this.veyra.audit(tx, null, { type: 'user', userId }, 'records.import_checked', {
        importId: id,
        files: stored.map((f) => f.filename),
        tables: check.tables.map((x) => ({
          label: x.label,
          rows: x.rows,
          ready: x.ready,
          existing: x.existing,
          errors: x.errors,
        })),
        errorCount: check.errors.length,
      });
    });
    return this.dto(await this.row(id));
  }

  /**
   * Imports a checked upload. Safe to call twice: an import already done is returned as is; one
   * interrupted after the ERP write replays through the connector's idempotency key.
   */
  async confirm(id: string, userId: string): Promise<ApiImport> {
    await this.requireDesignated(userId);
    const row = await this.row(id);
    if (row.status === 'imported') return this.dto(row);
    const files = await Promise.all(
      (JSON.parse(row.filesJson) as StoredFile[]).map(async (f) => ({
        filename: f.filename,
        bytes: await this.veyra.storage.get(this.keyOf(id, f), { sha256: f.sha256 }),
      })),
    );
    const check = await this.run(files);
    const save = async (patch: Partial<typeof t.imports.$inferInsert>) => {
      await this.veyra.db.update(t.imports).set(patch).where(eq(t.imports.id, id));
    };
    if (check.errors.length) {
      await save({ status: 'invalid', checkJson: JSON.stringify(check) });
      throw new VeyraError('INVALID_STATE', 'This upload has problems. Nothing was imported.', {
        import: this.dto(await this.row(id)),
      });
    }
    let result: ImportBusinessRecordsResult;
    try {
      result = await this.veyra.erp.importBusinessRecords(
        { ...check.batch, importId: id },
        importIdempotencyKey(id),
      );
    } catch (e) {
      if (!isErpConnectorError(e) || e.retryable) throw e;
      // The ERP refused the batch (e.g. a record changed since the check): nothing was written.
      const again = await this.run(files);
      await save({
        status: again.errors.length ? 'invalid' : 'ready',
        checkJson: JSON.stringify(again),
      });
      throw new VeyraError(
        'INVALID_STATE',
        'Your business records changed since this upload was checked. Nothing was imported.',
        {
          import: this.dto(await this.row(id)),
        },
      );
    }
    const now = this.veyra.now();
    await this.veyra.db.transaction(async (tx) => {
      const marked = await tx
        .update(t.imports)
        .set({
          status: 'imported',
          checkJson: JSON.stringify(check),
          resultJson: JSON.stringify(result),
          confirmedByUserId: userId,
          confirmedAt: now,
        })
        .where(and(eq(t.imports.id, id), ne(t.imports.status, 'imported')))
        .returning({ id: t.imports.id });
      // Confirmed concurrently by another request: the ERP write was idempotent (same key) and
      // that request recorded it; nothing more to record here.
      if (marked.length === 0) return;
      await this.veyra.audit(tx, null, { type: 'user', userId }, 'records.import_confirmed', {
        importId: id,
        files: files.map((f) => f.filename),
      });
      await this.veyra.audit(tx, null, { type: 'system' }, 'records.imported', {
        importId: id,
        created: { ...result.created },
        skipped: { ...result.skipped },
      });
    });
    return this.dto(await this.row(id));
  }

  async list(): Promise<ApiImport[]> {
    return (
      await this.veyra.db
        .select()
        .from(t.imports)
        .orderBy(desc(t.imports.createdAt), desc(t.imports.seq))
    ).map((r) => this.dto(r));
  }

  async get(id: string): Promise<ApiImport> {
    return this.dto(await this.row(id));
  }

  private async row(id: string): Promise<ImportRow> {
    const row = (
      await this.veyra.db.select().from(t.imports).where(eq(t.imports.id, id)).limit(1)
    )[0];
    if (!row) throw new VeyraError('NOT_FOUND', 'Import not found.');
    return row;
  }

  private async requireDesignated(userId: string): Promise<void> {
    if (userId !== (await this.veyra.designatedUserId()))
      throw new VeyraError(
        'NOT_DESIGNATED_USER',
        'Only the designated user can import business records.',
      );
  }

  private dto(row: ImportRow): ApiImport {
    const check = JSON.parse(row.checkJson) as ImportCheck;
    const result = row.resultJson
      ? (JSON.parse(row.resultJson) as ImportBusinessRecordsResult)
      : null;
    return {
      id: row.id,
      status: row.status as ApiImport['status'],
      files: (JSON.parse(row.filesJson) as StoredFile[]).map((f) => f.filename),
      kinds: row.kinds,
      createdAt: row.createdAt,
      confirmedAt: row.confirmedAt,
      tables: check.tables,
      errors: check.errors.slice(0, 500),
      errorCount: check.errors.length,
      notices: check.notices,
      canConfirm: row.status === 'ready' && check.tables.some((x) => x.ready > 0),
      result: result ? { created: result.created, skipped: result.skipped } : null,
    };
  }
}
