CREATE TABLE `company` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`gstin` text NOT NULL,
	`state_code` text NOT NULL,
	CONSTRAINT "company_singleton" CHECK("company"."id" = 'company'),
	CONSTRAINT "company_gstin" CHECK(length("company"."gstin") = 15 AND "company"."gstin" GLOB '[0-9][0-9]*'),
	CONSTRAINT "company_state_matches_gstin" CHECK("company"."state_code" = substr("company"."gstin", 1, 2))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_gstin_unique` ON `company` (`gstin`);--> statement-breakpoint
CREATE TABLE `grn_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`grn_id` text NOT NULL,
	`po_line_id` text NOT NULL,
	`received_qty_milli` integer NOT NULL,
	`accepted_qty_milli` integer NOT NULL,
	FOREIGN KEY (`grn_id`) REFERENCES `grns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`po_line_id`) REFERENCES `po_lines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "grn_lines_received" CHECK(typeof("grn_lines"."received_qty_milli") = 'integer' AND "grn_lines"."received_qty_milli" > 0),
	CONSTRAINT "grn_lines_accepted" CHECK(typeof("grn_lines"."accepted_qty_milli") = 'integer' AND "grn_lines"."accepted_qty_milli" >= 0 AND "grn_lines"."accepted_qty_milli" <= "grn_lines"."received_qty_milli")
);
--> statement-breakpoint
CREATE INDEX `grn_lines_po_line_idx` ON `grn_lines` (`po_line_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `grn_lines_grn_po_line_uq` ON `grn_lines` (`grn_id`,`po_line_id`);--> statement-breakpoint
CREATE TABLE `grns` (
	`id` text PRIMARY KEY NOT NULL,
	`grn_number` text NOT NULL,
	`po_id` text NOT NULL,
	`grn_date` text NOT NULL,
	`origin` text NOT NULL,
	`confirmed_by_user_id` text,
	`source_invoice_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "grns_date" CHECK(date("grns"."grn_date") IS "grns"."grn_date"),
	CONSTRAINT "grns_origin" CHECK("grns"."origin" IN ('seed', 'user_confirmed_via_veyra')),
	CONSTRAINT "grns_origin_source" CHECK(("grns"."origin" = 'seed') = ("grns"."source_invoice_id" IS NULL)),
	CONSTRAINT "grns_origin_confirmer" CHECK(("grns"."origin" = 'user_confirmed_via_veyra') = ("grns"."confirmed_by_user_id" IS NOT NULL)),
	CONSTRAINT "grns_created_at" CHECK("grns"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grns_grn_number_unique` ON `grns` (`grn_number`);--> statement-breakpoint
CREATE INDEX `grns_po_idx` ON `grns` (`po_id`);--> statement-breakpoint
CREATE TABLE `idempotency_log` (
	`key` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`payload_hash` text NOT NULL,
	`result_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "idempotency_log_operation" CHECK("idempotency_log"."operation" IN ('reactivateVendor', 'createVendor', 'createItem', 'createVendorItemAlias', 'createPurchaseOrder', 'createGrn', 'recordPurchaseInvoice')),
	CONSTRAINT "idempotency_log_hash" CHECK(length("idempotency_log"."payload_hash") = 64 AND "idempotency_log"."payload_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "idempotency_log_created_at" CHECK("idempotency_log"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`hsn_sac` text NOT NULL,
	`uom` text NOT NULL,
	`gst_rate_bp` integer NOT NULL,
	`origin` text NOT NULL,
	`source_invoice_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "items_hsn" CHECK(length("items"."hsn_sac") IN (4, 6, 8) AND "items"."hsn_sac" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "items_gst_rate" CHECK(typeof("items"."gst_rate_bp") = 'integer' AND "items"."gst_rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "items_origin" CHECK("items"."origin" IN ('seed', 'created_by_veyra')),
	CONSTRAINT "items_origin_source" CHECK(("items"."origin" = 'seed') = ("items"."source_invoice_id" IS NULL)),
	CONSTRAINT "items_created_at" CHECK("items"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_code_unique` ON `items` (`code`);--> statement-breakpoint
CREATE INDEX `items_hsn_idx` ON `items` (`hsn_sac`);--> statement-breakpoint
CREATE INDEX `items_name_hsn_idx` ON `items` (`name_normalized`,`hsn_sac`);--> statement-breakpoint
CREATE TABLE `po_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`po_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`item_id` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_price_paise` integer NOT NULL,
	`gst_rate_bp` integer NOT NULL,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "po_lines_line_no" CHECK(typeof("po_lines"."line_no") = 'integer' AND "po_lines"."line_no" > 0),
	CONSTRAINT "po_lines_qty" CHECK(typeof("po_lines"."qty_milli") = 'integer' AND "po_lines"."qty_milli" > 0),
	CONSTRAINT "po_lines_price" CHECK(typeof("po_lines"."unit_price_paise") = 'integer' AND "po_lines"."unit_price_paise" >= 0),
	CONSTRAINT "po_lines_gst_rate" CHECK(typeof("po_lines"."gst_rate_bp") = 'integer' AND "po_lines"."gst_rate_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE INDEX `po_lines_item_idx` ON `po_lines` (`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `po_lines_po_line_uq` ON `po_lines` (`po_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `purchase_invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_invoice_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`po_line_id` text NOT NULL,
	`item_id` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_price_paise` integer NOT NULL,
	`taxable_paise` integer NOT NULL,
	`gst_rate_bp` integer NOT NULL,
	`cgst_paise` integer,
	`sgst_paise` integer,
	`igst_paise` integer,
	FOREIGN KEY (`purchase_invoice_id`) REFERENCES `purchase_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`po_line_id`) REFERENCES `po_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_invoice_lines_line_no" CHECK(typeof("purchase_invoice_lines"."line_no") = 'integer' AND "purchase_invoice_lines"."line_no" > 0),
	CONSTRAINT "purchase_invoice_lines_qty" CHECK(typeof("purchase_invoice_lines"."qty_milli") = 'integer' AND "purchase_invoice_lines"."qty_milli" > 0),
	CONSTRAINT "purchase_invoice_lines_price" CHECK(typeof("purchase_invoice_lines"."unit_price_paise") = 'integer' AND "purchase_invoice_lines"."unit_price_paise" >= 0),
	CONSTRAINT "purchase_invoice_lines_taxable" CHECK(typeof("purchase_invoice_lines"."taxable_paise") = 'integer' AND "purchase_invoice_lines"."taxable_paise" >= 0),
	CONSTRAINT "purchase_invoice_lines_gst_rate" CHECK(typeof("purchase_invoice_lines"."gst_rate_bp") = 'integer' AND "purchase_invoice_lines"."gst_rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "purchase_invoice_lines_cgst" CHECK(("purchase_invoice_lines"."cgst_paise" IS NULL OR typeof("purchase_invoice_lines"."cgst_paise") = 'integer')),
	CONSTRAINT "purchase_invoice_lines_sgst" CHECK(("purchase_invoice_lines"."sgst_paise" IS NULL OR typeof("purchase_invoice_lines"."sgst_paise") = 'integer')),
	CONSTRAINT "purchase_invoice_lines_igst" CHECK(("purchase_invoice_lines"."igst_paise" IS NULL OR typeof("purchase_invoice_lines"."igst_paise") = 'integer'))
);
--> statement-breakpoint
CREATE INDEX `purchase_invoice_lines_po_line_idx` ON `purchase_invoice_lines` (`po_line_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_invoice_lines_line_uq` ON `purchase_invoice_lines` (`purchase_invoice_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `purchase_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`vendor_invoice_no` text NOT NULL,
	`vendor_invoice_no_normalized` text NOT NULL,
	`invoice_date` text NOT NULL,
	`fy` text NOT NULL,
	`po_id` text NOT NULL,
	`taxable_paise` integer NOT NULL,
	`cgst_paise` integer NOT NULL,
	`sgst_paise` integer NOT NULL,
	`igst_paise` integer NOT NULL,
	`round_off_paise` integer,
	`total_paise` integer NOT NULL,
	`status` text NOT NULL,
	`veyra_invoice_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_invoices_date" CHECK(date("purchase_invoices"."invoice_date") IS "purchase_invoices"."invoice_date"),
	CONSTRAINT "purchase_invoices_fy" CHECK("purchase_invoices"."fy" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "purchase_invoices_taxable" CHECK(typeof("purchase_invoices"."taxable_paise") = 'integer' AND "purchase_invoices"."taxable_paise" >= 0),
	CONSTRAINT "purchase_invoices_cgst" CHECK(typeof("purchase_invoices"."cgst_paise") = 'integer' AND "purchase_invoices"."cgst_paise" >= 0),
	CONSTRAINT "purchase_invoices_sgst" CHECK(typeof("purchase_invoices"."sgst_paise") = 'integer' AND "purchase_invoices"."sgst_paise" >= 0),
	CONSTRAINT "purchase_invoices_igst" CHECK(typeof("purchase_invoices"."igst_paise") = 'integer' AND "purchase_invoices"."igst_paise" >= 0),
	CONSTRAINT "purchase_invoices_round_off" CHECK(("purchase_invoices"."round_off_paise" IS NULL OR typeof("purchase_invoices"."round_off_paise") = 'integer')),
	CONSTRAINT "purchase_invoices_total_int" CHECK(typeof("purchase_invoices"."total_paise") = 'integer' AND "purchase_invoices"."total_paise" >= 0),
	CONSTRAINT "purchase_invoices_total" CHECK("purchase_invoices"."total_paise" = "purchase_invoices"."taxable_paise" + "purchase_invoices"."cgst_paise" + "purchase_invoices"."sgst_paise" + "purchase_invoices"."igst_paise" + coalesce("purchase_invoices"."round_off_paise", 0)),
	CONSTRAINT "purchase_invoices_status" CHECK("purchase_invoices"."status" = 'verified_pending_payment'),
	CONSTRAINT "purchase_invoices_created_at" CHECK("purchase_invoices"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_invoices_veyra_invoice_id_unique` ON `purchase_invoices` (`veyra_invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_invoices_idempotency_key_unique` ON `purchase_invoices` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `purchase_invoices_po_idx` ON `purchase_invoices` (`po_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_invoices_vendor_no_fy_uq` ON `purchase_invoices` (`vendor_id`,`vendor_invoice_no_normalized`,`fy`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`po_number` text NOT NULL,
	`vendor_id` text NOT NULL,
	`po_date` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`source_invoice_id` text,
	`approved_by_user_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_orders_date" CHECK(date("purchase_orders"."po_date") IS "purchase_orders"."po_date"),
	CONSTRAINT "purchase_orders_status" CHECK("purchase_orders"."status" IN ('open', 'closed')),
	CONSTRAINT "purchase_orders_origin" CHECK("purchase_orders"."origin" IN ('seed', 'auto_created_from_invoice', 'created_from_invoice_on_approval')),
	CONSTRAINT "purchase_orders_origin_source" CHECK(("purchase_orders"."origin" = 'seed') = ("purchase_orders"."source_invoice_id" IS NULL)),
	CONSTRAINT "purchase_orders_origin_approver" CHECK(("purchase_orders"."origin" = 'created_from_invoice_on_approval') = ("purchase_orders"."approved_by_user_id" IS NOT NULL)),
	CONSTRAINT "purchase_orders_created_at" CHECK("purchase_orders"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_orders_po_number_unique` ON `purchase_orders` (`po_number`);--> statement-breakpoint
CREATE INDEX `purchase_orders_vendor_idx` ON `purchase_orders` (`vendor_id`);--> statement-breakpoint
CREATE TABLE `vendor_item_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`vendor_item_code` text NOT NULL,
	`item_id` text NOT NULL,
	`origin` text NOT NULL,
	`source_invoice_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "vendor_item_aliases_code" CHECK(length("vendor_item_aliases"."vendor_item_code") > 0),
	CONSTRAINT "vendor_item_aliases_origin" CHECK("vendor_item_aliases"."origin" IN ('seed', 'created_by_veyra')),
	CONSTRAINT "vendor_item_aliases_origin_source" CHECK(("vendor_item_aliases"."origin" = 'seed') = ("vendor_item_aliases"."source_invoice_id" IS NULL)),
	CONSTRAINT "vendor_item_aliases_created_at" CHECK("vendor_item_aliases"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
CREATE INDEX `vendor_item_aliases_item_idx` ON `vendor_item_aliases` (`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_item_aliases_vendor_code_uq` ON `vendor_item_aliases` (`vendor_id`,`vendor_item_code`);--> statement-breakpoint
CREATE TABLE `vendors` (
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
	`created_at` text NOT NULL,
	CONSTRAINT "vendors_gstin" CHECK(length("vendors"."gstin") = 15 AND "vendors"."gstin" GLOB '[0-9][0-9]*'),
	CONSTRAINT "vendors_pan_matches_gstin" CHECK("vendors"."pan" = substr("vendors"."gstin", 3, 10)),
	CONSTRAINT "vendors_state_matches_gstin" CHECK("vendors"."state_code" = substr("vendors"."gstin", 1, 2)),
	CONSTRAINT "vendors_status" CHECK("vendors"."status" IN ('active', 'inactive')),
	CONSTRAINT "vendors_origin" CHECK("vendors"."origin" IN ('seed', 'created_by_veyra')),
	CONSTRAINT "vendors_origin_source" CHECK(("vendors"."origin" = 'seed') = ("vendors"."source_invoice_id" IS NULL)),
	CONSTRAINT "vendors_created_at" CHECK("vendors"."created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_code_unique` ON `vendors` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_gstin_unique` ON `vendors` (`gstin`);--> statement-breakpoint
CREATE INDEX `vendors_pan_idx` ON `vendors` (`pan`);--> statement-breakpoint
CREATE INDEX `vendors_name_normalized_idx` ON `vendors` (`name_normalized`);