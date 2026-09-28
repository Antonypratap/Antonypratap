CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text,
	`actor_type` text NOT NULL,
	`actor_user_id` text,
	`event` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`detail_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_events_actor" CHECK("audit_events"."actor_type" IN ('system', 'ai', 'user')),
	CONSTRAINT "audit_events_user" CHECK(("audit_events"."actor_type" = 'user') = ("audit_events"."actor_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `audit_events_invoice` ON `audit_events` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `creation_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`entity` text NOT NULL,
	`payload_json` text NOT NULL,
	`signature` text NOT NULL,
	`policy_code` text NOT NULL,
	`trigger` text NOT NULL,
	`approved_by_user_id` text,
	`question_id` text,
	`status` text NOT NULL,
	`erp_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	`committed_at` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "creation_actions_entity" CHECK("creation_actions"."entity" IN ('vendor', 'item', 'alias', 'po', 'grn', 'vendor_reactivation')),
	CONSTRAINT "creation_actions_trigger" CHECK("creation_actions"."trigger" IN ('auto_policy', 'user_approval')),
	CONSTRAINT "creation_actions_status" CHECK("creation_actions"."status" IN ('staged', 'committed', 'discarded')),
	CONSTRAINT "creation_actions_committed" CHECK(("creation_actions"."status" = 'committed') = ("creation_actions"."erp_id" IS NOT NULL AND "creation_actions"."committed_at" IS NOT NULL)),
	CONSTRAINT "creation_actions_approval" CHECK("creation_actions"."trigger" <> 'user_approval' OR ("creation_actions"."approved_by_user_id" IS NOT NULL AND "creation_actions"."question_id" IS NOT NULL)),
	CONSTRAINT "creation_actions_no_auto_grn_or_item" CHECK("creation_actions"."entity" NOT IN ('grn', 'item', 'vendor_reactivation') OR "creation_actions"."trigger" = 'user_approval')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creation_actions_idempotency_key_unique` ON `creation_actions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `creation_actions_invoice` ON `creation_actions` (`invoice_id`,`status`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_path` text NOT NULL,
	`uploaded_by_user_id` text NOT NULL,
	`uploaded_at` text NOT NULL,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_mime" CHECK("documents"."mime" IN ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "documents_size" CHECK(typeof("documents"."size_bytes") = 'integer' AND "documents"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_sha256_unique` ON `documents` (`sha256`);--> statement-breakpoint
CREATE TABLE `extracted_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`path` text NOT NULL,
	`value_json` text NOT NULL,
	`confidence_bp` integer,
	`evidence_json` text,
	`evidence_detail_json` text,
	`source` text NOT NULL,
	`extraction_id` text,
	`updated_by_user_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extraction_id`) REFERENCES `extractions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "extracted_fields_source" CHECK("extracted_fields"."source" IN ('extracted', 'human_confirmed', 'human_corrected', 'derived_from_erp_choice', 'derived_from_document_evidence')),
	CONSTRAINT "extracted_fields_confidence" CHECK("extracted_fields"."confidence_bp" IS NULL OR (typeof("extracted_fields"."confidence_bp") = 'integer' AND "extracted_fields"."confidence_bp" BETWEEN 0 AND 10000)),
	CONSTRAINT "extracted_fields_human" CHECK("extracted_fields"."source" NOT IN ('human_confirmed', 'human_corrected') OR "extracted_fields"."updated_by_user_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extracted_fields_path` ON `extracted_fields` (`invoice_id`,`path`);--> statement-breakpoint
CREATE TABLE `extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`extractor_id` text NOT NULL,
	`extractor_version` text NOT NULL,
	`raw_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`item_erp_id` text,
	`po_line_erp_id` text,
	`item_ref_staged_action_id` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_lines_no` ON `invoice_lines` (`invoice_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`state` text NOT NULL,
	`state_version` integer NOT NULL,
	`run_no` integer NOT NULL,
	`vendor_erp_id` text,
	`po_erp_id` text,
	`erp_purchase_invoice_id` text,
	`dup_vendor_gstin` text,
	`dup_invoice_no` text,
	`dup_fy` text,
	`commit_plan_json` text,
	`failed_stage` text,
	`failure_reason` text,
	`rejected_by_user_id` text,
	`rejected_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rejected_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoices_state" CHECK("invoices"."state" IN ('UPLOADED', 'EXTRACTING', 'MATCHING', 'RESOLVING', 'VALIDATING', 'NEEDS_INPUT', 'COMMITTING', 'VERIFIED_PENDING_PAYMENT', 'REJECTED', 'FAILED')),
	CONSTRAINT "invoices_version" CHECK(typeof("invoices"."state_version") = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_document_id_unique` ON `invoices` (`document_id`);--> statement-breakpoint
CREATE INDEX `invoices_dup` ON `invoices` (`dup_vendor_gstin`,`dup_invoice_no`,`dup_fy`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`run_after` text NOT NULL,
	`locked_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_type" CHECK("jobs"."type" IN ('pipeline', 'commit')),
	CONSTRAINT "jobs_status" CHECK("jobs"."status" IN ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `jobs_queue` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `match_results` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`run_no` integer NOT NULL,
	`entity` text NOT NULL,
	`line_no` integer,
	`outcome` text NOT NULL,
	`method` text NOT NULL,
	`candidates_json` text NOT NULL,
	`chosen_erp_id` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "match_results_entity" CHECK("match_results"."entity" IN ('vendor', 'item', 'po', 'grn')),
	CONSTRAINT "match_results_outcome" CHECK("match_results"."outcome" IN ('found', 'not_found', 'ambiguous'))
);
--> statement-breakpoint
CREATE INDEX `match_results_run` ON `match_results` (`invoice_id`,`run_no`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`kind` text NOT NULL,
	`code` text NOT NULL,
	`subject_key` text NOT NULL,
	`prompt` text NOT NULL,
	`context_json` text NOT NULL,
	`options_json` text NOT NULL,
	`input_schema_json` text,
	`status` text NOT NULL,
	`assigned_to_user_id` text NOT NULL,
	`answer_json` text,
	`answered_by_user_id` text,
	`answered_at` text,
	`answer_seq` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`answered_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "questions_kind" CHECK("questions"."kind" IN ('MISSING_DATA', 'AMBIGUOUS_MATCH', 'BUSINESS_DECISION', 'VALIDATION_FAILURE', 'CREATION_APPROVAL')),
	CONSTRAINT "questions_status" CHECK("questions"."status" IN ('open', 'answered', 'superseded')),
	CONSTRAINT "questions_answer" CHECK(("questions"."status" = 'answered') = ("questions"."answer_json" IS NOT NULL AND "questions"."answered_by_user_id" IS NOT NULL AND "questions"."answered_at" IS NOT NULL AND "questions"."answer_seq" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `questions_open_subject` ON `questions` (`invoice_id`,`code`,`subject_key`) WHERE "questions"."status" = 'open';--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_by_user_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`active` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `validation_results` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`run_no` integer NOT NULL,
	`rule_code` text NOT NULL,
	`line_no` integer,
	`outcome` text NOT NULL,
	`na_reason` text,
	`expected_json` text NOT NULL,
	`actual_json` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "validation_results_outcome" CHECK("validation_results"."outcome" IN ('pass', 'fail', 'not_applicable', 'not_evaluated')),
	CONSTRAINT "validation_results_na" CHECK(("validation_results"."outcome" = 'not_applicable') = ("validation_results"."na_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `validation_results_run` ON `validation_results` (`invoice_id`,`run_no`);