CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`files_json` text NOT NULL,
	`kinds` text NOT NULL,
	`status` text NOT NULL,
	`check_json` text NOT NULL,
	`result_json` text,
	`uploaded_by_user_id` text NOT NULL,
	`confirmed_by_user_id` text,
	`created_at` text NOT NULL,
	`confirmed_at` text,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "imports_status" CHECK("imports"."status" IN ('ready', 'invalid', 'imported')),
	CONSTRAINT "imports_confirmed" CHECK(("imports"."status" = 'imported') = ("imports"."result_json" IS NOT NULL AND "imports"."confirmed_at" IS NOT NULL AND "imports"."confirmed_by_user_id" IS NOT NULL))
);
