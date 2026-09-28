/**
 * Domain enumerations. Each is a readonly tuple (usable by Zod's `z.enum`) plus its union type.
 */

export const INVOICE_STATES = [
  'UPLOADED',
  'EXTRACTING',
  'MATCHING',
  'RESOLVING',
  'VALIDATING',
  'NEEDS_INPUT',
  'COMMITTING',
  'VERIFIED_PENDING_PAYMENT',
  'REJECTED',
  'FAILED',
] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];
/** No transition leaves these states (FAILED is not terminal: it can be reprocessed). */
export const TERMINAL_INVOICE_STATES = [
  'VERIFIED_PENDING_PAYMENT',
  'REJECTED',
] as const satisfies readonly InvoiceState[];

export const QUESTION_KINDS = [
  'MISSING_DATA',
  'AMBIGUOUS_MATCH',
  'BUSINESS_DECISION',
  'VALIDATION_FAILURE',
  'CREATION_APPROVAL',
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_STATUSES = ['open', 'answered', 'superseded'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const MATCH_ENTITIES = ['vendor', 'item', 'po', 'grn'] as const;
export type MatchEntity = (typeof MATCH_ENTITIES)[number];

export const MATCH_OUTCOMES = ['found', 'not_found', 'ambiguous'] as const;
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

/** The FIND step (RULES §2) that produced a match result, per entity. */
export const MATCH_METHODS_BY_ENTITY = {
  vendor: ['gstin', 'pan', 'normalized_name', 'user_choice'],
  po: ['po_number', 'open_po', 'user_choice'],
  item: ['vendor_alias', 'po_line_hsn', 'item_name_hsn', 'item_hsn', 'user_choice'],
  grn: ['po_grns'],
} as const satisfies Record<MatchEntity, readonly string[]>;
export const MATCH_METHODS = [
  'gstin',
  'pan',
  'normalized_name',
  'po_number',
  'open_po',
  'vendor_alias',
  'po_line_hsn',
  'item_name_hsn',
  'item_hsn',
  'po_grns',
  'user_choice',
] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

/** Where a field's current value came from (RULES §1.3). */
export const FIELD_SOURCES = [
  'extracted',
  'human_confirmed',
  'human_corrected',
  'derived_from_erp_choice',
  'derived_from_document_evidence',
] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

/** Whether an extracted field may be used (RULES §1.3). Only `usable` fields are ever used. */
export const FIELD_STATUSES = ['usable', 'missing', 'low_confidence', 'unparseable'] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

export const EXTRACTOR_IDS = ['fixture', 'local_ocr', 'ollama'] as const;

/**
 * How one value was read (Phase 3D): the PDF's own text layer, Tesseract OCR, an optional local
 * Ollama model (always grounded in the document text), or the demo fixture extractor.
 */
export const EXTRACTION_METHODS = ['pdf_text', 'tesseract', 'ollama', 'fixture'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];
export type ExtractorId = (typeof EXTRACTOR_IDS)[number];

export const CREATION_ENTITIES = [
  'vendor',
  'item',
  'alias',
  'po',
  'grn',
  'vendor_reactivation',
] as const;
export type CreationEntity = (typeof CREATION_ENTITIES)[number];

export const CREATION_TRIGGERS = ['auto_policy', 'user_approval'] as const;
export type CreationTrigger = (typeof CREATION_TRIGGERS)[number];

export const CREATION_ACTION_STATUSES = ['staged', 'committed', 'discarded'] as const;
export type CreationActionStatus = (typeof CREATION_ACTION_STATUSES)[number];

/** Creation policy codes (RULES §3) with the entity and trigger each one permits. */
export const CREATION_POLICIES = {
  CP_VENDOR_AUTO: { entity: 'vendor', trigger: 'auto_policy' },
  CP_VENDOR_APPROVED: { entity: 'vendor', trigger: 'user_approval' },
  CP_ITEM_APPROVED: { entity: 'item', trigger: 'user_approval' },
  CP_ALIAS_UNIQUE_PO_LINE: { entity: 'alias', trigger: 'auto_policy' },
  CP_PO_BELOW_THRESHOLD: { entity: 'po', trigger: 'auto_policy' },
  CP_PO_APPROVED: { entity: 'po', trigger: 'user_approval' },
  CP_GRN_USER_CONFIRMED: { entity: 'grn', trigger: 'user_approval' },
  CP_VENDOR_REACTIVATED: { entity: 'vendor_reactivation', trigger: 'user_approval' },
} as const satisfies Record<string, { entity: CreationEntity; trigger: CreationTrigger }>;
export type CreationPolicyCode = keyof typeof CREATION_POLICIES;
export const CREATION_POLICY_CODES = Object.keys(CREATION_POLICIES) as [
  CreationPolicyCode,
  ...CreationPolicyCode[],
];

export const VALIDATION_OUTCOMES = ['pass', 'fail', 'not_applicable', 'not_evaluated'] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];

export const AUDIT_ACTOR_TYPES = ['system', 'ai', 'user'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_EVENTS = [
  'invoice.uploaded',
  'invoice.state_changed',
  'invoice.rejected',
  'invoice.failed',
  'extraction.completed',
  'field.confirmed',
  'field.corrected',
  'field.derived',
  'match.recorded',
  'creation.staged',
  'creation.approved',
  'creation.committed',
  'creation.discarded',
  'validation.completed',
  'question.raised',
  'question.answered',
  'question.superseded',
  'commit.started',
  'commit.conflict',
  'commit.completed',
  'settings.changed',
  'records.import_checked',
  'records.import_confirmed',
  'records.imported',
] as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[number];

export const JOB_TYPES = ['pipeline', 'commit'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const ERP_ENTITY_TYPES = [
  'company',
  'vendor',
  'item',
  'vendor_item_alias',
  'purchase_order',
  'po_line',
  'grn',
  'grn_line',
  'purchase_invoice',
  'purchase_invoice_line',
] as const;
export type ErpEntityType = (typeof ERP_ENTITY_TYPES)[number];

export const VENDOR_STATUSES = ['active', 'inactive'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

/** `imported`: provided by the business through an import of its own records (Phase 3C). */
export const MASTER_ORIGINS = ['seed', 'created_by_veyra', 'imported'] as const;
export type MasterOrigin = (typeof MASTER_ORIGINS)[number];

export const PO_STATUSES = ['open', 'closed'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const PO_ORIGINS = [
  'seed',
  'auto_created_from_invoice',
  'created_from_invoice_on_approval',
  'imported',
] as const;
export type PoOrigin = (typeof PO_ORIGINS)[number];

export const GRN_ORIGINS = ['seed', 'user_confirmed_via_veyra', 'imported'] as const;
export type GrnOrigin = (typeof GRN_ORIGINS)[number];

/** V1 is India / GST / INR only. */
export const CURRENCIES = ['INR'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const SUPPORTED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;
export type SupportedDocumentMimeType = (typeof SUPPORTED_DOCUMENT_MIME_TYPES)[number];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
