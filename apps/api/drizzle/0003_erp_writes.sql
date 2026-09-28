CREATE TABLE `erp_writes` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`erp_id` text,
	`external_ref` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "erp_writes_status" CHECK("erp_writes"."status" IN ('pending', 'confirmed', 'not_created', 'unknown', 'failed')),
	CONSTRAINT "erp_writes_confirmed" CHECK("erp_writes"."status" <> 'confirmed' OR "erp_writes"."erp_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `erp_writes_invoice` ON `erp_writes` (`invoice_id`);