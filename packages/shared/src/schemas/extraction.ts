import { z } from 'zod';
import { IsoDateSchema, IsoDateTimeSchema } from '../dates';
import { EXTRACTION_METHODS, EXTRACTOR_IDS, FIELD_SOURCES, type ExtractionMethod } from '../enums';
import { FieldPathSchema } from '../fields';
import { ExtractionIdSchema, InvoiceIdSchema, UserIdSchema } from '../ids';
import { MilliQtySchema, NonNegativeMilliQtySchema } from '../quantity';
import { NonNegativePaiseSchema, PaiseSchema } from '../money';
import { ConfidenceBpSchema, RateBpSchema } from '../rate';
import { StateCodeSchema, JsonObjectSchema, LineNoSchema } from './common';

/** Where on the document a value was read. `bbox` is [x, y, width, height] in page pixels. */
export const EvidenceSchema = z.object({
  page: z.int().positive(),
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * One value proposed by an extractor: `{ value, confidence, evidence, source }`. Extraction output
 * is untrusted: `value` is only a proposal until the deterministic core decides it is usable
 * (RULES §1.3), and `confidenceBp` is the extractor's own confidence, never proof. `null` means
 * "not found". `source` says how the value was read.
 */
export function extractedFieldSchema<T extends z.ZodType>(value: T) {
  return z.object({
    value: value.nullable(),
    confidenceBp: ConfidenceBpSchema,
    evidence: EvidenceSchema.nullable(),
    source: z.enum(EXTRACTION_METHODS),
  });
}
export interface ExtractedField<T> {
  value: T | null;
  confidenceBp: z.infer<typeof ConfidenceBpSchema>;
  evidence: Evidence | null;
  source: ExtractionMethod;
}

const text = z.string().min(1);
const field = extractedFieldSchema;

/** Normalised header values as an extractor proposes them. Raw text stays in `evidence.text`. */
export const ExtractedHeaderSchema = z.object({
  vendorName: field(text),
  vendorGstin: field(text),
  vendorAddress: field(text),
  vendorPan: field(text),
  buyerGstin: field(text),
  billingAddress: field(text),
  placeOfSupply: field(text),
  shipToState: field(text),
  shipToGstin: field(text),
  shipToAddress: field(text),
  invoiceNumber: field(text),
  invoiceDate: field(IsoDateSchema),
  poNumber: field(text),
  taxablePaise: field(NonNegativePaiseSchema),
  cgstPaise: field(NonNegativePaiseSchema),
  sgstPaise: field(NonNegativePaiseSchema),
  igstPaise: field(NonNegativePaiseSchema),
  cessPaise: field(NonNegativePaiseSchema),
  roundOffPaise: field(PaiseSchema),
  totalPaise: field(NonNegativePaiseSchema),
});
export type ExtractedHeader = z.infer<typeof ExtractedHeaderSchema>;

export const ExtractedLineSchema = z.object({
  lineNo: LineNoSchema,
  description: field(text),
  vendorItemCode: field(text),
  hsnSac: field(text),
  qtyMilli: field(NonNegativeMilliQtySchema),
  uom: field(text),
  unitPricePaise: field(NonNegativePaiseSchema),
  discountPaise: field(NonNegativePaiseSchema),
  taxablePaise: field(NonNegativePaiseSchema),
  gstRateBp: field(RateBpSchema),
  cgstPaise: field(NonNegativePaiseSchema),
  sgstPaise: field(NonNegativePaiseSchema),
  igstPaise: field(NonNegativePaiseSchema),
  lineTotalPaise: field(NonNegativePaiseSchema),
});
export type ExtractedLine = z.infer<typeof ExtractedLineSchema>;

/**
 * A value printed on the document that has no field of its own (IRN, e-way bill, bank details,
 * payment terms, transporter…): kept exactly as printed, with where it was read. Never used by
 * the deterministic core; it is shown and exported so nothing printed is thrown away.
 */
export const OtherPrintedFieldSchema = z.object({
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(2000),
  confidenceBp: ConfidenceBpSchema,
  evidence: EvidenceSchema.nullable(),
});
export type OtherPrintedField = z.infer<typeof OtherPrintedFieldSchema>;

/** How a document was read (for the server log; never document content). */
export const ExtractionDiagnosticsSchema = z.object({
  /** The readers that ran, in order (for example ["ai_vision"] or ["ai_vision", "local_ocr"]). */
  readers: z.array(z.string().min(1)).max(10),
  /** Pages read from a PDF text layer. */
  textPages: z.int().nonnegative(),
  /** Pages read as images (scan images, or whole pages drawn as images). */
  imagePages: z.int().nonnegative(),
  /** Whether pages had to be drawn as images because the PDF had no usable text. */
  rendered: z.boolean(),
  /**
   * What the AI reader used for this reading (calls made, tokens billed), for Veyrafy's own cost
   * accounting. Absent when no AI reader was called.
   */
  ai: z
    .object({
      model: z.string().max(100).nullable(),
      calls: z.int().nonnegative(),
      inputTokens: z.int().nonnegative(),
      outputTokens: z.int().nonnegative(),
    })
    .optional(),
  /** How long reading the document took (milliseconds). */
  durationMs: z.int().nonnegative().optional(),
});
export type ExtractionDiagnostics = z.infer<typeof ExtractionDiagnosticsSchema>;

/** What every Extractor implementation returns (ARCHITECTURE §3.1). */
export const ExtractionResultSchema = z
  .object({
    /** Which extractor produced this reading (recorded with the extraction). */
    extractor: z.object({ id: z.enum(EXTRACTOR_IDS), version: z.string().min(1) }),
    header: ExtractedHeaderSchema,
    lines: z.array(ExtractedLineSchema),
    pages: z.int().positive(),
    warnings: z.array(z.string()),
    /** Everything else printed on the document, as printed (optional: not every reader has it). */
    otherFields: z.array(OtherPrintedFieldSchema).max(300).optional(),
    diagnostics: ExtractionDiagnosticsSchema.optional(),
  })
  .superRefine((r, ctx) => {
    r.lines.forEach((line, i) => {
      if (line.lineNo !== i + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'lineNo'],
          message: 'lines must be numbered 1..n in order',
        });
      }
    });
  });
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/** Current value of one field of an invoice, as stored by Veyra (the `fields` table). */
export const FieldRecordSchema = z
  .object({
    invoiceId: InvoiceIdSchema,
    path: FieldPathSchema,
    value: z.json().nullable(),
    confidenceBp: ConfidenceBpSchema.nullable(),
    evidence: EvidenceSchema.nullable(),
    evidenceDetail: JsonObjectSchema.nullable(),
    source: z.enum(FIELD_SOURCES),
    extractionId: ExtractionIdSchema.nullable(),
    updatedByUserId: UserIdSchema.nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .superRefine((f, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (f.source === 'extracted') {
      if (f.confidenceBp === null) issue('extracted values carry a confidence');
      if (f.extractionId === null) issue('extracted values reference their extraction');
    }
    if (
      (f.source === 'human_confirmed' || f.source === 'human_corrected') &&
      f.updatedByUserId === null
    ) {
      issue('human-sourced values record the user');
    }
    if (f.source === 'derived_from_document_evidence' && f.evidenceDetail === null) {
      issue('derived values record the evidence they were derived from');
    }
  });
export type FieldRecord = z.infer<typeof FieldRecordSchema>;

// Re-exported for consumers that type header values precisely.
export { StateCodeSchema, MilliQtySchema };
