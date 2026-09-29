CREATE INDEX "extractions_invoice" ON "extractions" USING btree ("invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_invoice" ON "jobs" USING btree ("invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "questions_invoice" ON "questions" USING btree ("invoice_id","seq");--> statement-breakpoint
CREATE INDEX "questions_open" ON "questions" USING btree ("seq") WHERE "questions"."status" = 'open';