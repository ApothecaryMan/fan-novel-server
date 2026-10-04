CREATE TABLE "chapter_view_dedup" (
	"novel_id" varchar(100) NOT NULL,
	"chapter_number" integer NOT NULL,
	"viewer_key" varchar(64) NOT NULL,
	"last_viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "novels" ADD COLUMN "views_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chapter_view_dedup" ADD CONSTRAINT "chapter_view_dedup_novel_id_novels_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chapter_view_dedup_pk" ON "chapter_view_dedup" USING btree ("novel_id","chapter_number","viewer_key");--> statement-breakpoint
CREATE INDEX "chapter_view_dedup_recent_idx" ON "chapter_view_dedup" USING btree ("last_viewed_at");