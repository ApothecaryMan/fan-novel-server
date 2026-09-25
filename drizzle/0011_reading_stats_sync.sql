ALTER TABLE "users" ADD COLUMN "reading_stats_plan" varchar(10) DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_reading_stats_plan_check" CHECK ("reading_stats_plan" in ('free', 'pro'));--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD COLUMN "progress_percent" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD COLUMN "completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD COLUMN "completion_signal_present" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD COLUMN "pro_fields_present" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "library_user_updated_id_idx" ON "user_library" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "history_user_read_at_id_idx" ON "reading_history" USING btree ("user_id","read_at","id");--> statement-breakpoint
CREATE INDEX "sessions_user_novel_chapter_idx" ON "reading_sessions" USING btree ("user_id","novel_id","chapter_id");--> statement-breakpoint
CREATE INDEX "sessions_user_read_day_idx" ON "reading_sessions" USING btree ("user_id","read_day");--> statement-breakpoint
CREATE INDEX "sessions_user_ts_id_idx" ON "reading_sessions" USING btree ("user_id","ts","id");
