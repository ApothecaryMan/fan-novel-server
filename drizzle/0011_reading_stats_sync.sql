-- 0011 index rollout note:
-- Drizzle's node-postgres migrator executes pending journal migrations in one
-- transaction. PostgreSQL therefore rejects CREATE INDEX CONCURRENTLY here.
-- The bounded lock/statement timeouts make the fallback fail fast, but an
-- ordinary CREATE INDEX still needs a low-write/maintenance window on large
-- tables. For a zero-downtime rollout, run `npm run db:indexes:concurrent`
-- first; the IF NOT EXISTS clauses below then skip the prebuilt indexes.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30min';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_plan" varchar(10) DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_reading_stats_plan_check" CHECK ("reading_stats_plan" in ('free', 'pro'));--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD COLUMN "progress_percent" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD COLUMN "completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD COLUMN "completion_signal_present" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD COLUMN "pro_fields_present" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_user_updated_id_idx" ON "user_library" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "history_user_read_at_id_idx" ON "reading_history" USING btree ("user_id","read_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_novel_chapter_idx" ON "reading_sessions" USING btree ("user_id","novel_id","chapter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_read_day_idx" ON "reading_sessions" USING btree ("user_id","read_day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_ts_id_idx" ON "reading_sessions" USING btree ("user_id","ts","id");
