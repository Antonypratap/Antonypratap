import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import {
  AUDIT_ACTOR_TYPES,
  CREATION_ACTION_STATUSES,
  CREATION_ENTITIES,
  CREATION_TRIGGERS,
  EXTRACTION_METHODS,
  FIELD_SOURCES,
  INVOICE_STATES,
  JOB_STATUSES,
  JOB_TYPES,
  MATCH_ENTITIES,
  MATCH_OUTCOMES,
  QUESTION_KINDS,
  QUESTION_STATUSES,
  VALIDATION_OUTCOMES,
} from '@veyra/shared';

/**
 * veyra.db (ARCHITECTURE §4.2). Veyra's own workflow data; ERP records live behind ErpConnector.
 * Ids are ULIDs, timestamps ISO-8601 UTC text. Money, quantities and rates never appear as
 * columns here: they live inside Zod-validated JSON (field values, staged payloads) as integers.
 */

const inList = (col: AnySQLiteColumn, values: readonly string[]) =>
  sql`${col} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
const isInteger = (col: AnySQLiteColumn) => sql`typeof(${col}) = 'integer'`;

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedByUserId: text('updated_by_user_id').references(() => users.id),
  updatedAt: text('updated_at').notNull(),
});

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    sha256: text('sha256').notNull().unique(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storagePath: text('storage_path').notNull(),
    uploadedByUserId: text('uploaded_by_user_id')
      .notNull()
      .references(() => users.id),
    uploadedAt: text('uploaded_at').notNull(),
  },
  (t) => [
    check('documents_mime', inList(t.mime, ['application/pdf', 'image/jpeg', 'image/png'])),
    check('documents_size', sql`${isInteger(t.sizeBytes)} AND ${t.sizeBytes} > 0`),
  ],
);

export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .unique()
      .references(() => documents.id),
    state: text('state').notNull(),
    /** Optimistic lock: every transition bumps it. */
    stateVersion: integer('state_version').notNull(),
    /** Number of the latest MATCHING → VALIDATING run. */
    runNo: integer('run_no').notNull(),
    vendorErpId: text('vendor_erp_id'),
    poErpId: text('po_erp_id'),
    erpPurchaseInvoiceId: text('erp_purchase_invoice_id'),
    /** Business duplicate key (RULES R11), set once the fields are usable. */
    dupVendorGstin: text('dup_vendor_gstin'),
    dupInvoiceNo: text('dup_invoice_no'),
    dupFy: text('dup_fy'),
    /** The frozen plan COMMITTING executes (and resumes after a crash). */
    commitPlanJson: text('commit_plan_json'),
    failedStage: text('failed_stage'),
    failureReason: text('failure_reason'),
    rejectedByUserId: text('rejected_by_user_id').references(() => users.id),
    rejectedReason: text('rejected_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('invoices_state', inList(t.state, INVOICE_STATES)),
    check('invoices_version', isInteger(t.stateVersion)),
    index('invoices_dup').on(t.dupVendorGstin, t.dupInvoiceNo, t.dupFy),
  ],
);

export const extractions = sqliteTable('extractions', {
  id: text('id').primaryKey(),
  invoiceId: text('invoice_id')
    .notNull()
    .references(() => invoices.id),
  extractorId: text('extractor_id').notNull(),
  extractorVersion: text('extractor_version').notNull(),
  rawJson: text('raw_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const extractedFields = sqliteTable(
  'extracted_fields',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    path: text('path').notNull(),
    valueJson: text('value_json').notNull(),
    confidenceBp: integer('confidence_bp'),
    evidenceJson: text('evidence_json'),
    evidenceDetailJson: text('evidence_detail_json'),
    source: text('source').notNull(),
    /** How an extracted value was read (pdf_text, tesseract, ollama, fixture); null otherwise. */
    method: text('method'),
    extractionId: text('extraction_id').references(() => extractions.id),
    updatedByUserId: text('updated_by_user_id').references(() => users.id),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('extracted_fields_path').on(t.invoiceId, t.path),
    check('extracted_fields_source', inList(t.source, FIELD_SOURCES)),
    check(
      'extracted_fields_method',
      sql`${t.method} IS NULL OR ${inList(t.method, EXTRACTION_METHODS)}`,
    ),
    check(
      'extracted_fields_confidence',
      sql`${t.confidenceBp} IS NULL OR (${isInteger(t.confidenceBp)} AND ${t.confidenceBp} BETWEEN 0 AND 10000)`,
    ),
    check(
      'extracted_fields_human',
      sql`${t.source} NOT IN ('human_confirmed', 'human_corrected') OR ${t.updatedByUserId} IS NOT NULL`,
    ),
  ],
);

export const invoiceLines = sqliteTable(
  'invoice_lines',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    lineNo: integer('line_no').notNull(),
    itemErpId: text('item_erp_id'),
    poLineErpId: text('po_line_erp_id'),
    itemRefStagedActionId: text('item_ref_staged_action_id'),
  },
  (t) => [uniqueIndex('invoice_lines_no').on(t.invoiceId, t.lineNo)],
);

export const matchResults = sqliteTable(
  'match_results',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    runNo: integer('run_no').notNull(),
    entity: text('entity').notNull(),
    lineNo: integer('line_no'),
    outcome: text('outcome').notNull(),
    method: text('method').notNull(),
    candidatesJson: text('candidates_json').notNull(),
    chosenErpId: text('chosen_erp_id'),
  },
  (t) => [
    check('match_results_entity', inList(t.entity, MATCH_ENTITIES)),
    check('match_results_outcome', inList(t.outcome, MATCH_OUTCOMES)),
    index('match_results_run').on(t.invoiceId, t.runNo),
  ],
);

export const creationActions = sqliteTable(
  'creation_actions',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    entity: text('entity').notNull(),
    payloadJson: text('payload_json').notNull(),
    /** Deterministic identity of what is staged, so a re-run reuses the same action. */
    signature: text('signature').notNull(),
    policyCode: text('policy_code').notNull(),
    trigger: text('trigger').notNull(),
    approvedByUserId: text('approved_by_user_id').references(() => users.id),
    questionId: text('question_id'),
    status: text('status').notNull(),
    erpId: text('erp_id'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: text('created_at').notNull(),
    committedAt: text('committed_at'),
  },
  (t) => [
    check('creation_actions_entity', inList(t.entity, CREATION_ENTITIES)),
    check('creation_actions_trigger', inList(t.trigger, CREATION_TRIGGERS)),
    check('creation_actions_status', inList(t.status, CREATION_ACTION_STATUSES)),
    check(
      'creation_actions_committed',
      sql`(${t.status} = 'committed') = (${t.erpId} IS NOT NULL AND ${t.committedAt} IS NOT NULL)`,
    ),
    check(
      'creation_actions_approval',
      sql`${t.trigger} <> 'user_approval' OR (${t.approvedByUserId} IS NOT NULL AND ${t.questionId} IS NOT NULL)`,
    ),
    check(
      'creation_actions_no_auto_grn_or_item',
      sql`${t.entity} NOT IN ('grn', 'item', 'vendor_reactivation') OR ${t.trigger} = 'user_approval'`,
    ),
    index('creation_actions_invoice').on(t.invoiceId, t.status),
  ],
);

export const validationResults = sqliteTable(
  'validation_results',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    runNo: integer('run_no').notNull(),
    ruleCode: text('rule_code').notNull(),
    lineNo: integer('line_no'),
    outcome: text('outcome').notNull(),
    naReason: text('na_reason'),
    expectedJson: text('expected_json').notNull(),
    actualJson: text('actual_json').notNull(),
    message: text('message').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('validation_results_outcome', inList(t.outcome, VALIDATION_OUTCOMES)),
    check(
      'validation_results_na',
      sql`(${t.outcome} = 'not_applicable') = (${t.naReason} IS NOT NULL)`,
    ),
    index('validation_results_run').on(t.invoiceId, t.runNo),
  ],
);

export const questions = sqliteTable(
  'questions',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    kind: text('kind').notNull(),
    code: text('code').notNull(),
    subjectKey: text('subject_key').notNull(),
    prompt: text('prompt').notNull(),
    contextJson: text('context_json').notNull(),
    optionsJson: text('options_json').notNull(),
    inputSchemaJson: text('input_schema_json'),
    status: text('status').notNull(),
    assignedToUserId: text('assigned_to_user_id')
      .notNull()
      .references(() => users.id),
    answerJson: text('answer_json'),
    answeredByUserId: text('answered_by_user_id').references(() => users.id),
    answeredAt: text('answered_at'),
    /** Global order of answers, so "the latest decision" is unambiguous. */
    answerSeq: integer('answer_seq'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('questions_kind', inList(t.kind, QUESTION_KINDS)),
    check('questions_status', inList(t.status, QUESTION_STATUSES)),
    check(
      'questions_answer',
      sql`(${t.status} = 'answered') = (${t.answerJson} IS NOT NULL AND ${t.answeredByUserId} IS NOT NULL AND ${t.answeredAt} IS NOT NULL AND ${t.answerSeq} IS NOT NULL)`,
    ),
    uniqueIndex('questions_open_subject')
      .on(t.invoiceId, t.code, t.subjectKey)
      .where(sql`${t.status} = 'open'`),
  ],
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id').references(() => invoices.id),
    actorType: text('actor_type').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id),
    event: text('event').notNull(),
    fromState: text('from_state'),
    toState: text('to_state'),
    detailJson: text('detail_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('audit_events_actor', inList(t.actorType, AUDIT_ACTOR_TYPES)),
    check('audit_events_user', sql`(${t.actorType} = 'user') = (${t.actorUserId} IS NOT NULL)`),
    index('audit_events_invoice').on(t.invoiceId),
  ],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    type: text('type').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),
    runAfter: text('run_after').notNull(),
    lockedAt: text('locked_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('jobs_type', inList(t.type, JOB_TYPES)),
    check('jobs_status', inList(t.status, JOB_STATUSES)),
    index('jobs_queue').on(t.status, t.runAfter),
  ],
);

/**
 * Business-record imports (Phase 3C). The uploaded files are kept (storage dir) so a confirmation
 * re-validates against the ERP as it is at that moment. Records themselves live in the ERP.
 */
export const imports = sqliteTable(
  'imports',
  {
    id: text('id').primaryKey(),
    filesJson: text('files_json').notNull(),
    kinds: text('kinds').notNull(),
    status: text('status').notNull(),
    checkJson: text('check_json').notNull(),
    resultJson: text('result_json'),
    uploadedByUserId: text('uploaded_by_user_id')
      .notNull()
      .references(() => users.id),
    confirmedByUserId: text('confirmed_by_user_id').references(() => users.id),
    createdAt: text('created_at').notNull(),
    confirmedAt: text('confirmed_at'),
  },
  (t) => [
    check('imports_status', inList(t.status, ['ready', 'invalid', 'imported'])),
    check(
      'imports_confirmed',
      sql`(${t.status} = 'imported') = (${t.resultJson} IS NOT NULL AND ${t.confirmedAt} IS NOT NULL AND ${t.confirmedByUserId} IS NOT NULL)`,
    ),
  ],
);
