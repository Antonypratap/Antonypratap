import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  REQUIRED_SOURCE_FIELDS,
  type ApiDataSource,
  type ApiSourceInspect,
  type ApiSourcePreview,
  type ApiSourcesInfo,
  type ApiSourceSync,
  type SourceLayout,
  type SourceOrigin,
} from '@veyra/shared';
import * as t from '../db/schema';
import { collectReceipts, type RegisterResult } from '../challenge/register';
import { MAX_IMPORT_FILE_BYTES } from '../imports/validate';
import { ulid } from '../ids';
import { readSpreadsheet } from '../spreadsheet/read';
import { MAX_ROWS, SpreadsheetError, type SheetRow } from '../spreadsheet/xlsx';
import { invoiceNoKey, normalizeReceipt, ReceiptFileSchema } from '../workflow/erp-receipts';
import { VeyraError, type Veyra } from '../workflow/veyra';
import {
  applyMapping,
  cleanMapping,
  detectHeaderRow,
  headerSignature,
  headerTexts,
  proposeMapping,
  sampleValues,
  type Mapping,
} from './mapping';
import { parseSheetLink, SheetsError, type SheetsReader } from './sheets';

/**
 * Spreadsheet registers (docs/ARCHITECTURE.md, "Data sources"). A business keeps its purchase or
 * GRN register in Excel, CSV or a Google Sheet; a person confirms which column holds which field
 * once, and every sync reads the register through that mapping into receipt records, which each
 * invoice is checked against line by line (Veyra.receiptCheck). Nothing is guessed: a changed set
 * of columns stops the sync until the mapping is reviewed, and a row without its invoice number,
 * supplier or item is never imported.
 */

type SourceRow = typeof t.dataSources.$inferSelect;
interface Loaded {
  kind: 'upload' | 'google_sheet';
  name: string;
  spreadsheetId: string | null;
  sheets: { title: string; rows: SheetRow[] }[];
}

/** A register is bounded by the sheet's rows, not by the challenge's invoice limit. */
const MAX_SOURCE_INVOICES = MAX_ROWS;
/** How many row problems are listed (all are counted). */
const SHOWN = 50;

const columnLetter = (i: number): string =>
  (i >= 26 ? columnLetter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));

export class DataSources {
  /** Syncs in flight, per source: concurrent requests share one read of the sheet. */
  private readonly inFlight = new Map<string, Promise<ApiSourceSync>>();
  /** The refresh before checks in flight: invoices checked together share it. */
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly veyra: Veyra,
    private readonly sheets: SheetsReader | null,
    readonly refreshMinutes = 15,
  ) {}

  private async guard(userId: string): Promise<void> {
    await this.veyra.requireActor(userId, 'imports.manage');
    await this.veyra.entitlements.require(this.veyra.organizationId, 'erp.spreadsheet_sources');
  }

  private google(): SheetsReader {
    if (!this.sheets)
      throw new VeyraError(
        'INVALID_INPUT',
        'Google Sheets is not connected on this Veyrafy. Upload the sheet as Excel or CSV instead.',
      );
    return this.sheets;
  }

  /** Reads what a person points at: an uploaded file, or (every tab of) a Google Sheet. */
  private async load(origin: SourceOrigin, onlyTab?: string): Promise<Loaded> {
    if (origin.kind === 'upload') {
      const bytes = Buffer.from(origin.contentBase64, 'base64');
      if (bytes.length === 0) throw new VeyraError('INVALID_INPUT', 'The file is empty.');
      if (bytes.length > MAX_IMPORT_FILE_BYTES)
        throw new VeyraError('INVALID_INPUT', 'The file is larger than 5 MB.');
      try {
        const book = readSpreadsheet(bytes, origin.filename);
        return {
          kind: 'upload',
          name: origin.filename,
          spreadsheetId: null,
          sheets: book.sheets.map((s) => ({ title: s.name, rows: s.rows })),
        };
      } catch (e) {
        if (e instanceof SpreadsheetError) throw new VeyraError('INVALID_INPUT', e.message);
        throw e;
      }
    }
    const link = parseSheetLink(origin.link);
    if (!link)
      throw new VeyraError(
        'INVALID_INPUT',
        'This is not a Google Sheets link. Copy the address of the sheet from your browser.',
      );
    return this.loadGoogle(link.spreadsheetId, onlyTab);
  }

  private async loadGoogle(spreadsheetId: string, onlyTab?: string): Promise<Loaded> {
    const google = this.google();
    try {
      const meta = await google.open(spreadsheetId);
      const tabs = meta.tabs.filter((tab) => onlyTab === undefined || tab.title === onlyTab);
      const sheets: Loaded['sheets'] = [];
      // At most 10 tabs are read to suggest a mapping; the chosen one is read on every sync.
      for (const tab of tabs.slice(0, 10))
        sheets.push({ title: tab.title, rows: await google.readTab(spreadsheetId, tab.title) });
      return { kind: 'google_sheet', name: meta.title, spreadsheetId, sheets };
    } catch (e) {
      if (e instanceof SheetsError) throw new VeyraError('INVALID_INPUT', e.message);
      throw e;
    }
  }

  /** The tabs of a file or sheet, the header row Veyrafy found, and its proposed mapping. */
  async inspect(origin: SourceOrigin, userId: string): Promise<ApiSourceInspect> {
    await this.guard(userId);
    const loaded = await this.load(origin);
    const tabs = loaded.sheets
      .filter((s) => s.rows.some((r) => r.cells.some((c) => c.text.trim() !== '')))
      .map((s) => {
        const at = detectHeaderRow(s.rows);
        const header = headerTexts(s.rows[at]);
        let last = header.length;
        while (last > 0 && (header[last - 1] ?? '') === '') last -= 1;
        return {
          title: s.title,
          rows: Math.max(0, s.rows.length - at - 1),
          headerRow: s.rows[at]?.rowNumber ?? 1,
          columns: header.slice(0, last).map((h, i) => ({
            index: i,
            header: h || `Column ${columnLetter(i)}`,
            samples: sampleValues(s.rows, at, i),
          })),
          proposed: proposeMapping(header.slice(0, last)),
        };
      });
    if (tabs.length === 0)
      throw new VeyraError('INVALID_INPUT', 'There is nothing in this spreadsheet to read.');
    return { kind: loaded.kind, name: loaded.name, spreadsheetId: loaded.spreadsheetId, tabs };
  }

  /** A sheet read through a layout: the register's records and its row problems. */
  private evaluate(
    loaded: Loaded,
    layout: SourceLayout,
  ): { result: RegisterResult; header: string[]; mapping: Mapping } {
    const sheet = loaded.sheets.find((s) => s.title === layout.sheetTitle);
    if (!sheet)
      throw new VeyraError(
        'INVALID_INPUT',
        `The tab “${layout.sheetTitle}” is not in this spreadsheet.`,
      );
    const at = sheet.rows.findIndex((r) => r.rowNumber === layout.headerRow);
    if (at < 0)
      throw new VeyraError(
        'INVALID_INPUT',
        `Row ${layout.headerRow} of “${layout.sheetTitle}” is empty: choose the row with the column names.`,
      );
    const header = headerTexts(sheet.rows[at]);
    const mapping = cleanMapping(layout.mapping, header.length);
    const read = applyMapping(sheet.rows, at, mapping);
    return {
      result: collectReceipts(read.rows, read.rowNumbers, MAX_SOURCE_INVOICES),
      header,
      mapping,
    };
  }

  private previewOf(result: RegisterResult, mapping: Mapping): ApiSourcePreview {
    const unmappedRequired = REQUIRED_SOURCE_FIELDS.filter((f) => mapping[f] === undefined);
    return {
      invoices: result.invoices,
      lines: result.lines,
      unmappedRequired,
      // While a required field has no column, every row "misses" it: that is one problem, shown
      // as the unmapped field, not as thousands of rows.
      errorCount: unmappedRequired.length ? 0 : result.errors.length,
      errors: unmappedRequired.length ? [] : result.errors.slice(0, SHOWN),
      warningCount: result.warnings.length,
      warnings: result.warnings.slice(0, SHOWN),
      tooMany: result.tooMany,
    };
  }

  /** What saving would import, with every row problem. Nothing is stored. */
  async preview(origin: SourceOrigin, layout: SourceLayout, userId: string) {
    await this.guard(userId);
    const loaded = await this.load(
      origin,
      origin.kind === 'google_sheet' ? layout.sheetTitle : undefined,
    );
    const { result, mapping } = this.evaluate(loaded, layout);
    return this.previewOf(result, mapping);
  }

  private requireUsable(preview: ApiSourcePreview): void {
    if (preview.unmappedRequired.length)
      throw new VeyraError(
        'INVALID_INPUT',
        'Choose the columns holding the invoice number, the supplier and the item.',
      );
    if (preview.invoices === 0)
      throw new VeyraError('INVALID_INPUT', 'No invoice lines were found with this mapping.');
    if (preview.tooMany)
      throw new VeyraError(
        'INVALID_INPUT',
        `This register has more than ${MAX_SOURCE_INVOICES} invoices. Keep it to the invoices being checked.`,
      );
  }

  /** Saves a source with its confirmed mapping, then reads it for the first time. */
  async create(
    input: { origin: SourceOrigin; layout: SourceLayout; name: string },
    userId: string,
  ): Promise<ApiDataSource> {
    await this.guard(userId);
    const loaded = await this.load(
      input.origin,
      input.origin.kind === 'google_sheet' ? input.layout.sheetTitle : undefined,
    );
    const { result, header, mapping } = this.evaluate(loaded, input.layout);
    this.requireUsable(this.previewOf(result, mapping));
    const id = ulid();
    const now = this.veyra.now();
    await this.veyra.db.transaction(async (tx) => {
      await tx.insert(t.dataSources).values({
        id,
        kind: loaded.kind,
        name: input.name,
        spreadsheetId: loaded.spreadsheetId,
        sheetTitle: input.layout.sheetTitle,
        headerRow: input.layout.headerRow,
        mappingJson: JSON.stringify(mapping),
        headerSignature: headerSignature(header),
        enabled: true,
        createdByUserId: userId,
        createdAt: now,
      });
      await this.veyra.audit(tx, null, { type: 'user', userId }, 'source.saved', {
        sourceId: id,
        kind: loaded.kind,
        fields: Object.keys(mapping).length,
      });
    });
    await this.runSync(await this.row(id), loaded, userId);
    return this.get(id);
  }

  /** A new mapping (or tab, or header row) for an existing source, then a sync with it. */
  async relayout(
    id: string,
    layout: SourceLayout,
    origin: SourceOrigin | null,
    userId: string,
  ): Promise<ApiDataSource> {
    await this.guard(userId);
    const row = await this.row(id);
    const loaded = await this.loadFor(row, origin, layout.sheetTitle);
    const { result, header, mapping } = this.evaluate(loaded, layout);
    this.requireUsable(this.previewOf(result, mapping));
    await this.veyra.db.transaction(async (tx) => {
      await tx
        .update(t.dataSources)
        .set({
          sheetTitle: layout.sheetTitle,
          headerRow: layout.headerRow,
          mappingJson: JSON.stringify(mapping),
          headerSignature: headerSignature(header),
        })
        .where(eq(t.dataSources.id, id));
      await this.veyra.audit(tx, null, { type: 'user', userId }, 'source.mapping_changed', {
        sourceId: id,
        fields: Object.keys(mapping).length,
      });
    });
    await this.runSync(await this.row(id), loaded, userId);
    return this.get(id);
  }

  /** Renames a source, or turns it off (its records stay; it is no longer synced) or on. */
  async update(
    id: string,
    patch: { name?: string | undefined; enabled?: boolean | undefined },
    userId: string,
  ): Promise<ApiDataSource> {
    await this.guard(userId);
    await this.row(id);
    const set: Partial<SourceRow> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (Object.keys(set).length)
      await this.veyra.db.update(t.dataSources).set(set).where(eq(t.dataSources.id, id));
    return this.get(id);
  }

  /** Reads the source again now. An uploaded register is synced from its newest file. */
  async sync(id: string, userId: string, upload: SourceOrigin | null): Promise<ApiDataSource> {
    await this.guard(userId);
    const row = await this.row(id);
    if (!row.enabled)
      throw new VeyraError('INVALID_INPUT', 'This source is turned off. Turn it on to sync it.');
    const loaded = await this.loadFor(row, upload, row.sheetTitle);
    await this.runSync(row, loaded, userId);
    return this.get(id);
  }

  private async loadFor(row: SourceRow, origin: SourceOrigin | null, tab: string): Promise<Loaded> {
    if (row.kind === 'google_sheet') return this.loadGoogle(row.spreadsheetId ?? '', tab);
    if (!origin || origin.kind !== 'upload')
      throw new VeyraError('INVALID_INPUT', 'Upload the latest copy of the register to sync it.');
    return this.load(origin);
  }

  /**
   * Google Sheets older than the refresh interval are read again before invoices are checked
   * (called by the pipeline, never inside a transaction). A failure is recorded and the last
   * synced records are used: a check is never held up by Google being unavailable.
   */
  refreshStale(): Promise<void> {
    if (!this.sheets) return Promise.resolve();
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const cutoff = new Date(
      Date.parse(this.veyra.now()) - this.refreshMinutes * 60_000,
    ).toISOString();
    const stale = await this.veyra.db
      .select()
      .from(t.dataSources)
      .where(
        and(
          eq(t.dataSources.kind, 'google_sheet'),
          eq(t.dataSources.enabled, true),
          sql`(${t.dataSources.lastSyncedAt} IS NULL OR ${t.dataSources.lastSyncedAt} < ${cutoff})`,
        ),
      );
    for (const row of stale) {
      await this.runSync(row, null, row.createdByUserId).catch(() => undefined);
    }
  }

  /** One sync of a source; concurrent calls for the same source share it. */
  private runSync(row: SourceRow, loaded: Loaded | null, userId: string): Promise<ApiSourceSync> {
    const running = this.inFlight.get(row.id);
    if (running) return running;
    const p = this.doSync(row, loaded, userId).finally(() => this.inFlight.delete(row.id));
    this.inFlight.set(row.id, p);
    return p;
  }

  private async doSync(
    row: SourceRow,
    given: Loaded | null,
    userId: string,
  ): Promise<ApiSourceSync> {
    const at = this.veyra.now();
    const finish = async (
      status: ApiSourceSync['status'],
      message: string,
      counts: Partial<
        Pick<ApiSourceSync, 'invoices' | 'imported' | 'rechecked' | 'rowErrors'>
      > = {},
    ): Promise<ApiSourceSync> => {
      const summary: ApiSourceSync = {
        at,
        status,
        message,
        invoices: counts.invoices ?? 0,
        imported: counts.imported ?? 0,
        rechecked: counts.rechecked ?? 0,
        rowErrors: counts.rowErrors ?? 0,
      };
      await this.veyra.db.transaction(async (tx) => {
        await tx
          .update(t.dataSources)
          .set({
            lastSyncedAt: at,
            lastSyncStatus: status,
            lastSyncSummaryJson: JSON.stringify(summary),
          })
          .where(eq(t.dataSources.id, row.id));
        // Counts and the reason only: never a value from the sheet.
        await this.veyra.audit(
          tx,
          null,
          { type: 'user', userId },
          status === 'ok' ? 'source.synced' : 'source.sync_failed',
          { sourceId: row.id, ...summary, message: status === 'ok' ? '' : message },
        );
      });
      return summary;
    };

    let loaded = given;
    try {
      loaded ??= await this.loadGoogle(row.spreadsheetId ?? '', row.sheetTitle);
    } catch (e) {
      return finish('failed', e instanceof VeyraError ? e.message : 'The sheet could not be read.');
    }
    const sheet = loaded.sheets.find((s) => s.title === row.sheetTitle);
    if (!sheet)
      return finish(
        'failed',
        `The tab “${row.sheetTitle}” is no longer in the spreadsheet. Edit the mapping to choose a tab.`,
      );
    const header = headerTexts(sheet.rows.find((r) => r.rowNumber === row.headerRow));
    if (headerSignature(header) !== row.headerSignature)
      return finish(
        'columns_changed',
        `The columns of “${row.sheetTitle}” changed since the mapping was confirmed. Review the mapping; nothing was read.`,
      );
    const mapping = JSON.parse(row.mappingJson) as Mapping;
    const { result } = this.evaluate(loaded, {
      sheetTitle: row.sheetTitle,
      headerRow: row.headerRow,
      mapping,
    });
    if (result.invoices === 0)
      return finish('ok', 'No invoice lines in the register.', { rowErrors: result.errors.length });
    let imported: Awaited<ReturnType<Veyra['importReceipts']>>;
    try {
      imported = await this.veyra.importReceipts(
        `${row.name} › ${row.sheetTitle}`,
        result.receipts,
        userId,
        { sourceId: row.id },
      );
    } catch (e) {
      return finish(
        'failed',
        e instanceof VeyraError ? e.message : 'The register could not be imported.',
      );
    }
    // Invoices this source supplied before that are no longer in the register: kept (an import
    // never deletes), and said, so nobody relies on a row that was removed.
    const now = new Set(
      ReceiptFileSchema.parse(result.receipts).data.map((r) =>
        invoiceNoKey(normalizeReceipt(r).invoiceNo),
      ),
    );
    const before = await this.veyra.db
      .selectDistinct({ key: t.erpReceiptRecords.invoiceNoKey })
      .from(t.erpReceiptRecords)
      .where(eq(t.erpReceiptRecords.sourceId, row.id));
    const gone = before.filter((b) => !now.has(b.key)).length;
    const parts = [
      `${result.invoices} invoice${result.invoices === 1 ? '' : 's'} in the register`,
      `${imported.imported} new or changed`,
      ...(imported.rechecked
        ? [
            `${imported.rechecked} waiting invoice${imported.rechecked === 1 ? '' : 's'} checked again`,
          ]
        : []),
      ...(result.errors.length
        ? [
            `${new Set(result.errors.map((e) => e.row)).size} row(s) skipped: no invoice number, supplier or item`,
          ]
        : []),
      ...(gone ? [`${gone} invoice${gone === 1 ? '' : 's'} no longer in the register (kept)`] : []),
    ];
    return finish('ok', `${parts.join('; ')}.`, {
      invoices: result.invoices,
      imported: imported.imported,
      rechecked: imported.rechecked,
      rowErrors: new Set(result.errors.map((e) => e.row)).size,
    });
  }

  private async row(id: string): Promise<SourceRow> {
    const row = (
      await this.veyra.db.select().from(t.dataSources).where(eq(t.dataSources.id, id)).limit(1)
    )[0];
    if (!row) throw new VeyraError('NOT_FOUND', 'No such source.');
    return row;
  }

  private dto(row: SourceRow, records: number): ApiDataSource {
    return {
      id: row.id,
      kind: row.kind as ApiDataSource['kind'],
      name: row.name,
      spreadsheetId: row.spreadsheetId,
      sheetTitle: row.sheetTitle,
      headerRow: row.headerRow,
      mapping: JSON.parse(row.mappingJson) as Mapping,
      enabled: row.enabled,
      records,
      lastSync: row.lastSyncSummaryJson
        ? (JSON.parse(row.lastSyncSummaryJson) as ApiSourceSync)
        : null,
      createdAt: row.createdAt,
    };
  }

  private async counts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.veyra.db
      .select({ id: t.erpReceiptRecords.sourceId, n: sql<number>`count(*)::int` })
      .from(t.erpReceiptRecords)
      .where(inArray(t.erpReceiptRecords.sourceId, ids))
      .groupBy(t.erpReceiptRecords.sourceId);
    return new Map(rows.map((r) => [r.id ?? '', Number(r.n)]));
  }

  async get(id: string): Promise<ApiDataSource> {
    const row = await this.row(id);
    return this.dto(row, (await this.counts([id])).get(id) ?? 0);
  }

  async info(): Promise<ApiSourcesInfo> {
    const rows = await this.veyra.db.select().from(t.dataSources).orderBy(t.dataSources.seq);
    const counts = await this.counts(rows.map((r) => r.id));
    return {
      google: this.sheets !== null,
      serviceEmail: this.sheets?.serviceEmail ?? null,
      refreshMinutes: this.refreshMinutes,
      sources: rows.map((r) => this.dto(r, counts.get(r.id) ?? 0)),
    };
  }
}
