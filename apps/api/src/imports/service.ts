import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
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
  path: string;
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

  private get dir(): string {
    return join(this.veyra.storageDir, 'imports');
  }

  snapshot(): Promise<ErpSnapshot> {
    return erpSnapshot(this.veyra.erp);
  }

  private async run(files: readonly UploadedFile[]): Promise<ImportCheck> {
    return checkImport(files, await this.snapshot(), this.veyra.today());
  }

  /** Validates an upload and stores it with its preview. Nothing is imported yet. */
  async check(files: readonly UploadedFile[], userId: string): Promise<ApiImport> {
    this.requireDesignated(userId);
    const id = ulid();
    const folder = join(this.dir, id);
    mkdirSync(folder, { recursive: true });
    const stored: StoredFile[] = files.map((f, i) => {
      const safe =
        (f.filename.split(/[\\/]/).pop() ?? 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120) ||
        'file';
      const path = join(folder, `${i + 1}-${safe}`);
      writeFileSync(path, f.bytes);
      return {
        filename: safe,
        path,
        sha256: createHash('sha256').update(f.bytes).digest('hex'),
        sizeBytes: f.bytes.length,
      };
    });
    const check = await this.run(
      files.map((f, i) => ({ filename: stored[i]?.filename ?? f.filename, bytes: f.bytes })),
    );
    const now = this.veyra.now();
    const kinds = check.tables.map((x) => x.label).join(', ') || 'No records';
    this.veyra.db.transaction((tx) => {
      tx.insert(t.imports)
        .values({
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
        })
        .run();
      this.veyra.audit(tx, null, { type: 'user', userId }, 'records.import_checked', {
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
    return this.dto(this.row(id));
  }

  /**
   * Imports a checked upload. Safe to call twice: an import already done is returned as is; one
   * interrupted after the ERP write replays through the connector's idempotency key.
   */
  async confirm(id: string, userId: string): Promise<ApiImport> {
    this.requireDesignated(userId);
    const row = this.row(id);
    if (row.status === 'imported') return this.dto(row);
    const files = (JSON.parse(row.filesJson) as StoredFile[]).map((f) => ({
      filename: f.filename,
      bytes: readFileSync(f.path),
    }));
    const check = await this.run(files);
    const save = (patch: Partial<typeof t.imports.$inferInsert>) =>
      this.veyra.db.update(t.imports).set(patch).where(eq(t.imports.id, id)).run();
    if (check.errors.length) {
      save({ status: 'invalid', checkJson: JSON.stringify(check) });
      throw new VeyraError('INVALID_STATE', 'This upload has problems. Nothing was imported.', {
        import: this.dto(this.row(id)),
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
      save({ status: again.errors.length ? 'invalid' : 'ready', checkJson: JSON.stringify(again) });
      throw new VeyraError(
        'INVALID_STATE',
        'Your business records changed since this upload was checked. Nothing was imported.',
        {
          import: this.dto(this.row(id)),
        },
      );
    }
    const now = this.veyra.now();
    this.veyra.db.transaction((tx) => {
      tx.update(t.imports)
        .set({
          status: 'imported',
          checkJson: JSON.stringify(check),
          resultJson: JSON.stringify(result),
          confirmedByUserId: userId,
          confirmedAt: now,
        })
        .where(eq(t.imports.id, id))
        .run();
      this.veyra.audit(tx, null, { type: 'user', userId }, 'records.import_confirmed', {
        importId: id,
        files: files.map((f) => f.filename),
      });
      this.veyra.audit(tx, null, { type: 'system' }, 'records.imported', {
        importId: id,
        created: { ...result.created },
        skipped: { ...result.skipped },
      });
    });
    return this.dto(this.row(id));
  }

  list(): ApiImport[] {
    return this.veyra.db
      .select()
      .from(t.imports)
      .orderBy(desc(t.imports.createdAt), desc(t.imports.id))
      .all()
      .map((r) => this.dto(r));
  }

  get(id: string): ApiImport {
    return this.dto(this.row(id));
  }

  private row(id: string): ImportRow {
    const row = this.veyra.db.select().from(t.imports).where(eq(t.imports.id, id)).get();
    if (!row) throw new VeyraError('NOT_FOUND', 'Import not found.');
    return row;
  }

  private requireDesignated(userId: string): void {
    if (userId !== this.veyra.designatedUserId())
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
