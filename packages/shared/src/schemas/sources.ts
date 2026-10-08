import { z } from 'zod';

/**
 * Spreadsheet registers (data sources): a purchase or GRN register kept in Excel, CSV or a
 * Google Sheet, read through a column mapping the person confirms (docs/ARCHITECTURE.md).
 */

const int = z.number().int();

/** The register fields a column can hold. The first three are required. */
export const SOURCE_FIELDS = [
  'invoiceNo',
  'supplier',
  'item',
  'date',
  'hsn',
  'qty',
  'uom',
  'rate',
  'amount',
  'cgst',
  'sgst',
  'igst',
  'total',
  'reference',
] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];
export const REQUIRED_SOURCE_FIELDS: readonly SourceField[] = ['invoiceNo', 'supplier', 'item'];
/** How each field is named on screen. */
export const SOURCE_FIELD_LABELS: Record<SourceField, string> = {
  invoiceNo: 'Invoice number',
  supplier: 'Supplier',
  item: 'Item',
  date: 'Invoice date',
  hsn: 'HSN / SAC',
  qty: 'Quantity',
  uom: 'Unit',
  rate: 'Rate',
  amount: 'Amount',
  cgst: 'CGST',
  sgst: 'SGST',
  igst: 'IGST',
  total: 'Invoice total',
  reference: 'GRN / receipt number',
};

export const SOURCE_KINDS = ['upload', 'google_sheet'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Which column (0-based) holds each field. */
export const SourceMappingSchema = z
  .object(Object.fromEntries(SOURCE_FIELDS.map((f) => [f, int.min(0).max(59).optional()])))
  .strict() as z.ZodType<Partial<Record<SourceField, number>>>;
export type SourceMapping = z.infer<typeof SourceMappingSchema>;

/** Where the rows come from: an uploaded file (sent again with each step) or a Google Sheet. */
export const SourceOriginSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('upload'),
      filename: z.string().trim().min(1).max(255),
      /** The file, base64-encoded. */
      contentBase64: z.string().min(4).max(8_000_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('google_sheet'),
      /** The sheet's link as copied from the browser. */
      link: z.string().trim().min(10).max(2000),
    })
    .strict(),
]);
export type SourceOrigin = z.infer<typeof SourceOriginSchema>;

/** Which tab, where the header is, and the mapping: what a preview and a save need. */
export const SourceLayoutSchema = z
  .object({
    sheetTitle: z.string().min(1).max(200),
    /** 1-based row number of the header row. */
    headerRow: int.min(1).max(20_000),
    mapping: SourceMappingSchema,
  })
  .strict();
export type SourceLayout = z.infer<typeof SourceLayoutSchema>;

export const ApiSourceColumnSchema = z.object({
  index: int,
  header: z.string(),
  samples: z.array(z.string()),
});
export const ApiSourceTabSchema = z.object({
  title: z.string(),
  rows: int,
  headerRow: int,
  columns: z.array(ApiSourceColumnSchema),
  proposed: SourceMappingSchema,
});
export const ApiSourceInspectSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  name: z.string(),
  spreadsheetId: z.string().nullable(),
  tabs: z.array(ApiSourceTabSchema),
});
export type ApiSourceInspect = z.infer<typeof ApiSourceInspectSchema>;

export const ApiSourceProblemSchema = z.object({
  row: int,
  field: z.enum(SOURCE_FIELDS).nullable(),
  problem: z.enum(['missing', 'not_a_number']),
});
export const ApiSourcePreviewSchema = z.object({
  invoices: int,
  lines: int,
  /** Required fields with no column: nothing can be saved until each has one. */
  unmappedRequired: z.array(z.enum(SOURCE_FIELDS)),
  errorCount: int,
  errors: z.array(ApiSourceProblemSchema),
  warningCount: int,
  warnings: z.array(ApiSourceProblemSchema),
  tooMany: z.boolean(),
});
export type ApiSourcePreview = z.infer<typeof ApiSourcePreviewSchema>;

export const SOURCE_SYNC_STATUSES = ['ok', 'failed', 'columns_changed'] as const;
export const ApiSourceSyncSchema = z.object({
  at: z.string(),
  status: z.enum(SOURCE_SYNC_STATUSES),
  /** Shown as is: what happened, or what to do. */
  message: z.string(),
  invoices: int,
  imported: int,
  rechecked: int,
  rowErrors: int,
});
export type ApiSourceSync = z.infer<typeof ApiSourceSyncSchema>;

export const ApiDataSourceSchema = z.object({
  id: z.string(),
  kind: z.enum(SOURCE_KINDS),
  name: z.string(),
  spreadsheetId: z.string().nullable(),
  sheetTitle: z.string(),
  headerRow: int,
  mapping: SourceMappingSchema,
  enabled: z.boolean(),
  records: int,
  lastSync: ApiSourceSyncSchema.nullable(),
  createdAt: z.string(),
});
export type ApiDataSource = z.infer<typeof ApiDataSourceSchema>;

/** What the Spreadsheets screen needs to know before a source is added. */
export const ApiSourcesInfoSchema = z.object({
  /** Google Sheets can be connected (Veyrafy's read-only service address is configured). */
  google: z.boolean(),
  /** The address a sheet is shared with (Viewer), when Google Sheets can be connected. */
  serviceEmail: z.string().nullable(),
  refreshMinutes: int,
  sources: z.array(ApiDataSourceSchema),
});
export type ApiSourcesInfo = z.infer<typeof ApiSourcesInfoSchema>;

/** Reading what a person points at, to suggest a mapping. */
export const SourceInspectSchema = z.object({ origin: SourceOriginSchema }).strict();
export const SourcePreviewSchema = z
  .object({ origin: SourceOriginSchema, layout: SourceLayoutSchema })
  .strict();
export const SourceCreateSchema = z
  .object({
    origin: SourceOriginSchema,
    layout: SourceLayoutSchema,
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export const SourceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
/** A changed mapping; an uploaded register sends its latest file with it. */
export const SourceRelayoutSchema = z
  .object({ layout: SourceLayoutSchema, origin: SourceOriginSchema.optional() })
  .strict();
/** Sync now; an uploaded register is synced from its latest file. */
export const SourceSyncSchema = z.object({ origin: SourceOriginSchema.optional() }).strict();
