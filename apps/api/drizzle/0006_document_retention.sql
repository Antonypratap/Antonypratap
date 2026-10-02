ALTER TABLE "jobs" DROP CONSTRAINT "jobs_type";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "status" text DEFAULT 'AVAILABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deleted_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "retention_mode" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_status" CHECK ("documents"."status" IN ('AVAILABLE', 'DELETED'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_retention_mode" CHECK ("documents"."retention_mode" IN ('KEEP', 'DELETE_AFTER_SUCCESS', 'DELETE_AFTER_DAYS'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_type" CHECK ("jobs"."type" IN ('pipeline', 'commit', 'retention'));