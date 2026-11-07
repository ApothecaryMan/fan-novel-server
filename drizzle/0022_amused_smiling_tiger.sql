CREATE TABLE "reading_novel_tombstones" (
	"user_id" uuid NOT NULL,
	"novel_id" varchar(100) NOT NULL,
	"deleted_at" bigint NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stats_reset_at" bigint;--> statement-breakpoint
ALTER TABLE "reading_novel_tombstones" ADD CONSTRAINT "reading_novel_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reading_novel_tombstones_pkey" ON "reading_novel_tombstones" USING btree ("user_id","novel_id");--> statement-breakpoint
CREATE INDEX "reading_novel_tombstones_user_idx" ON "reading_novel_tombstones" USING btree ("user_id");