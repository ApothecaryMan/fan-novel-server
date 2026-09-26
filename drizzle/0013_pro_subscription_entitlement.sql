CREATE TABLE "subscription_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subscription_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"previous_expires_at" bigint,
	"new_expires_at" bigint,
	"duration_days" integer,
	"reason" varchar(500),
	"occurred_at" bigint NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_events_type_check" CHECK ("subscription_events"."type" in ('grant', 'renew', 'revoke', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_plan_started_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_plan_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_trial_started_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_trial_ends_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_last_renewed_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_grace_until" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_plan_duration_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_plan_status" varchar(20) DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_renewal_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reading_stats_total_subscribed_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_events_user_occurred_idx" ON "subscription_events" USING btree ("user_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_events_expired_unique_idx" ON "subscription_events" USING btree ("user_id","previous_expires_at") WHERE "subscription_events"."type" = 'expired';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_reading_stats_plan_status_check" CHECK ("users"."reading_stats_plan_status" in ('free', 'active', 'expired', 'cancelled'));