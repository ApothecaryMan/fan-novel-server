CREATE TABLE "reading_chapter_state" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reading_chapter_state_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"novel_id" varchar(100) NOT NULL,
	"chapter_id" integer NOT NULL,
	"is_read" boolean NOT NULL,
	"origin" varchar(16) NOT NULL,
	"updated_at" bigint NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "reading_chapter_state_origin_check" CHECK ("origin" in ('manual', 'snapshot'))
);
--> statement-breakpoint
CREATE TABLE "reading_novels" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reading_novels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"novel_id" varchar(100) NOT NULL,
	"title" varchar(255) DEFAULT '' NOT NULL,
	"genre" varchar(100) DEFAULT '' NOT NULL,
	"source_id" varchar(100),
	"total_chapters" integer,
	"updated_at" bigint NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reading_chapter_state" ADD CONSTRAINT "reading_chapter_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_novels" ADD CONSTRAINT "reading_novels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reading_chapter_state_user_novel_chapter_idx" ON "reading_chapter_state" USING btree ("user_id","novel_id","chapter_id");--> statement-breakpoint
CREATE INDEX "reading_chapter_state_user_novel_idx" ON "reading_chapter_state" USING btree ("user_id","novel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reading_novels_user_novel_idx" ON "reading_novels" USING btree ("user_id","novel_id");
