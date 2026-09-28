-- Hand-corrected: drizzle-kit selected the new source_import_id column from the old tables;
-- existing rows get NULL (no existing record was imported).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_grns` (
	`id` text PRIMARY KEY NOT NULL,
	`grn_number` text NOT NULL,
	`po_id` text NOT NULL,
	`grn_date` text NOT NULL,
	`origin` text NOT NULL,
	`confirmed_by_user_id` text,
	`source_invoice_id` text,
	`source_import_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "grns_date" CHECK(date("__new_grns"."grn_date") IS "__new_grns"."grn_date"),
	CONSTRAINT "grns_origin" CHECK("__new_grns"."origin" IN ('seed', 'user_confirmed_via_veyra', 'imported')),
	CONSTRAINT "grns_origin_source" CHECK(("__new_grns"."origin" IN ('user_confirmed_via_veyra')) = ("__new_grns"."source_invoice_id" IS NOT NULL)),
	CONSTRAINT "grns_origin_import" CHECK(("__new_grns"."origin" = 'imported') = ("__new_grns"."source_import_id" IS NOT NULL)),
	CONSTRAINT "grns_origin_confirmer" CHECK(("__new_grns"."origin" = 'user_confirmed_via_veyra') = ("__new_grns"."confirmed_by_user_id" IS NOT NULL)),
	CONSTRAINT "grns_created_at" CHECK("__new_grns"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
INSERT INTO `__new_grns`("id", "grn_number", "po_id", "grn_date", "origin", "confirmed_by_user_id", "source_invoice_id", "source_import_id", "created_at") SELECT "id", "grn_number", "po_id", "grn_date", "origin", "confirmed_by_user_id", "source_invoice_id", NULL, "created_at" FROM `grns`;--> statement-breakpoint
DROP TABLE `grns`;--> statement-breakpoint
ALTER TABLE `__new_grns` RENAME TO `grns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `grns_grn_number_unique` ON `grns` (`grn_number`);--> statement-breakpoint
CREATE INDEX `grns_po_idx` ON `grns` (`po_id`);--> statement-breakpoint
CREATE TABLE `__new_idempotency_log` (
	`key` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`payload_hash` text NOT NULL,
	`result_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "idempotency_log_operation" CHECK("__new_idempotency_log"."operation" IN ('reactivateVendor', 'createVendor', 'createItem', 'createVendorItemAlias', 'createPurchaseOrder', 'createGrn', 'recordPurchaseInvoice', 'importBusinessRecords')),
	CONSTRAINT "idempotency_log_hash" CHECK(length("__new_idempotency_log"."payload_hash") = 64 AND "__new_idempotency_log"."payload_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "idempotency_log_created_at" CHECK("__new_idempotency_log"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
INSERT INTO `__new_idempotency_log`("key", "operation", "payload_hash", "result_id", "created_at") SELECT "key", "operation", "payload_hash", "result_id", "created_at" FROM `idempotency_log`;--> statement-breakpoint
DROP TABLE `idempotency_log`;--> statement-breakpoint
ALTER TABLE `__new_idempotency_log` RENAME TO `idempotency_log`;--> statement-breakpoint
CREATE TABLE `__new_items` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`hsn_sac` text NOT NULL,
	`uom` text NOT NULL,
	`gst_rate_bp` integer NOT NULL,
	`origin` text NOT NULL,
	`source_invoice_id` text,
	`source_import_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "items_hsn" CHECK(length("__new_items"."hsn_sac") IN (4, 6, 8) AND "__new_items"."hsn_sac" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "items_gst_rate" CHECK(typeof("__new_items"."gst_rate_bp") = 'integer' AND "__new_items"."gst_rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "items_origin" CHECK("__new_items"."origin" IN ('seed', 'created_by_veyra', 'imported')),
	CONSTRAINT "items_origin_source" CHECK(("__new_items"."origin" IN ('created_by_veyra')) = ("__new_items"."source_invoice_id" IS NOT NULL)),
	CONSTRAINT "items_origin_import" CHECK(("__new_items"."origin" = 'imported') = ("__new_items"."source_import_id" IS NOT NULL)),
	CONSTRAINT "items_created_at" CHECK("__new_items"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
INSERT INTO `__new_items`("id", "code", "name", "name_normalized", "hsn_sac", "uom", "gst_rate_bp", "origin", "source_invoice_id", "source_import_id", "created_at") SELECT "id", "code", "name", "name_normalized", "hsn_sac", "uom", "gst_rate_bp", "origin", "source_invoice_id", NULL, "created_at" FROM `items`;--> statement-breakpoint
DROP TABLE `items`;--> statement-breakpoint
ALTER TABLE `__new_items` RENAME TO `items`;--> statement-breakpoint
CREATE UNIQUE INDEX `items_code_unique` ON `items` (`code`);--> statement-breakpoint
CREATE INDEX `items_hsn_idx` ON `items` (`hsn_sac`);--> statement-breakpoint
CREATE INDEX `items_name_hsn_idx` ON `items` (`name_normalized`,`hsn_sac`);--> statement-breakpoint
CREATE TABLE `__new_purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`po_number` text NOT NULL,
	`vendor_id` text NOT NULL,
	`po_date` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`source_invoice_id` text,
	`approved_by_user_id` text,
	`source_import_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_orders_date" CHECK(date("__new_purchase_orders"."po_date") IS "__new_purchase_orders"."po_date"),
	CONSTRAINT "purchase_orders_status" CHECK("__new_purchase_orders"."status" IN ('open', 'closed')),
	CONSTRAINT "purchase_orders_origin" CHECK("__new_purchase_orders"."origin" IN ('seed', 'auto_created_from_invoice', 'created_from_invoice_on_approval', 'imported')),
	CONSTRAINT "purchase_orders_origin_source" CHECK(("__new_purchase_orders"."origin" IN ('auto_created_from_invoice', 'created_from_invoice_on_approval')) = ("__new_purchase_orders"."source_invoice_id" IS NOT NULL)),
	CONSTRAINT "purchase_orders_origin_import" CHECK(("__new_purchase_orders"."origin" = 'imported') = ("__new_purchase_orders"."source_import_id" IS NOT NULL)),
	CONSTRAINT "purchase_orders_origin_approver" CHECK(("__new_purchase_orders"."origin" = 'created_from_invoice_on_approval') = ("__new_purchase_orders"."approved_by_user_id" IS NOT NULL)),
	CONSTRAINT "purchase_orders_created_at" CHECK("__new_purchase_orders"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
INSERT INTO `__new_purchase_orders`("id", "po_number", "vendor_id", "po_date", "status", "origin", "source_invoice_id", "approved_by_user_id", "source_import_id", "created_at") SELECT "id", "po_number", "vendor_id", "po_date", "status", "origin", "source_invoice_id", "approved_by_user_id", NULL, "created_at" FROM `purchase_orders`;--> statement-breakpoint
DROP TABLE `purchase_orders`;--> statement-breakpoint
ALTER TABLE `__new_purchase_orders` RENAME TO `purchase_orders`;--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_orders_po_number_unique` ON `purchase_orders` (`po_number`);--> statement-breakpoint
CREATE INDEX `purchase_orders_vendor_idx` ON `purchase_orders` (`vendor_id`);--> statement-breakpoint
CREATE TABLE `__new_vendor_item_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`vendor_item_code` text NOT NULL,
	`item_id` text NOT NULL,
	`origin` text NOT NULL,
	`source_invoice_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "vendor_item_aliases_code" CHECK(length("__new_vendor_item_aliases"."vendor_item_code") > 0),
	CONSTRAINT "vendor_item_aliases_origin" CHECK("__new_vendor_item_aliases"."origin" IN ('seed', 'created_by_veyra')),
	CONSTRAINT "vendor_item_aliases_origin_source" CHECK(("__new_vendor_item_aliases"."origin" IN ('created_by_veyra')) = ("__new_vendor_item_aliases"."source_invoice_id" IS NOT NULL)),
	CONSTRAINT "vendor_item_aliases_created_at" CHECK("__new_vendor_item_aliases"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
INSERT INTO `__new_vendor_item_aliases`("id", "vendor_id", "vendor_item_code", "item_id", "origin", "source_invoice_id", "created_at") SELECT "id", "vendor_id", "vendor_item_code", "item_id", "origin", "source_invoice_id", "created_at" FROM `vendor_item_aliases`;--> statement-breakpoint
DROP TABLE `vendor_item_aliases`;--> statement-breakpoint
ALTER TABLE `__new_vendor_item_aliases` RENAME TO `vendor_item_aliases`;--> statement-breakpoint
CREATE INDEX `vendor_item_aliases_item_idx` ON `vendor_item_aliases` (`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_item_aliases_vendor_code_uq` ON `vendor_item_aliases` (`vendor_id`,`vendor_item_code`);--> statement-breakpoint
CREATE TABLE `__new_vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`gstin` text NOT NULL,
	`pan` text NOT NULL,
	`state_code` text NOT NULL,
	`address` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`source_invoice_id` text,
	`source_import_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "vendors_gstin" CHECK(length("__new_vendors"."gstin") = 15 AND "__new_vendors"."gstin" GLOB '[0-9][0-9]*'),
	CONSTRAINT "vendors_pan_matches_gstin" CHECK("__new_vendors"."pan" = substr("__new_vendors"."gstin", 3, 10)),
	CONSTRAINT "vendors_state_matches_gstin" CHECK("__new_vendors"."state_code" = substr("__new_vendors"."gstin", 1, 2)),
	CONSTRAINT "vendors_status" CHECK("__new_vendors"."status" IN ('active', 'inactive')),
	CONSTRAINT "vendors_origin" CHECK("__new_vendors"."origin" IN ('seed', 'created_by_veyra', 'imported')),
	CONSTRAINT "vendors_origin_source" CHECK(("__new_vendors"."origin" IN ('created_by_veyra')) = ("__new_vendors"."source_invoice_id" IS NOT NULL)),
	CONSTRAINT "vendors_origin_import" CHECK(("__new_vendors"."origin" = 'imported') = ("__new_vendors"."source_import_id" IS NOT NULL)),
	CONSTRAINT "vendors_created_at" CHECK("__new_vendors"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
INSERT INTO `__new_vendors`("id", "code", "name", "name_normalized", "gstin", "pan", "state_code", "address", "status", "origin", "source_invoice_id", "source_import_id", "created_at") SELECT "id", "code", "name", "name_normalized", "gstin", "pan", "state_code", "address", "status", "origin", "source_invoice_id", NULL, "created_at" FROM `vendors`;--> statement-breakpoint
DROP TABLE `vendors`;--> statement-breakpoint
ALTER TABLE `__new_vendors` RENAME TO `vendors`;--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_code_unique` ON `vendors` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_gstin_unique` ON `vendors` (`gstin`);--> statement-breakpoint
CREATE INDEX `vendors_pan_idx` ON `vendors` (`pan`);--> statement-breakpoint
CREATE INDEX `vendors_name_normalized_idx` ON `vendors` (`name_normalized`);