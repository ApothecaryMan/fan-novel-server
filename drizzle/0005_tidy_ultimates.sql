CREATE TABLE "comment_mod_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "comment_mod_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"comment_id" bigint NOT NULL,
	"action" varchar(20) NOT NULL,
	"actor_id" uuid,
	"reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_votes" (
	"comment_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"value" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"novel_id" varchar(100) NOT NULL,
	"chapter_number" integer,
	"user_id" uuid,
	"parent_id" bigint,
	"root_id" bigint,
	"depth" smallint DEFAULT 0 NOT NULL,
	"body" text NOT NULL,
	"body_hash" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'visible' NOT NULL,
	"likes_count" integer DEFAULT 0 NOT NULL,
	"replies_count" integer DEFAULT 0 NOT NULL,
	"reports_count" integer DEFAULT 0 NOT NULL,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_reason" varchar(500),
	CONSTRAINT "comments_depth_check" CHECK ("depth" BETWEEN 0 AND 3),
	CONSTRAINT "comments_body_check" CHECK (char_length("body") BETWEEN 1 AND 2000),
	CONSTRAINT "comments_status_check" CHECK ("status" IN ('visible','pending','hidden','deleted')),
	CONSTRAINT "comments_thread_check" CHECK ((("parent_id" IS NULL) AND ("root_id" IS NULL) AND ("depth" = 0)) OR (("parent_id" IS NOT NULL) AND ("root_id" IS NOT NULL) AND ("depth" BETWEEN 1 AND 3)))
);
--> statement-breakpoint
ALTER TABLE "comment_mod_log" ADD CONSTRAINT "comment_mod_log_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mod_log" ADD CONSTRAINT "comment_mod_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_votes" ADD CONSTRAINT "comment_votes_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_votes" ADD CONSTRAINT "comment_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_novel_id_novels_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_root_id_comments_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_votes_pkey" ON "comment_votes" USING btree ("comment_id","user_id");--> statement-breakpoint
CREATE INDEX "comment_votes_user" ON "comment_votes" USING btree ("user_id","comment_id");--> statement-breakpoint
CREATE INDEX "comments_roots_new" ON "comments" USING btree ("novel_id","chapter_number","created_at" DESC,"id" DESC) WHERE "parent_id" IS NULL AND "status" = 'visible';--> statement-breakpoint
CREATE INDEX "comments_roots_top" ON "comments" USING btree ("novel_id","chapter_number","likes_count" DESC,"id" DESC) WHERE "parent_id" IS NULL AND "status" = 'visible';--> statement-breakpoint
CREATE INDEX "comments_thread" ON "comments" USING btree ("root_id","created_at","id") WHERE "status" = 'visible';--> statement-breakpoint
CREATE INDEX "comments_parent" ON "comments" USING btree ("parent_id","created_at","id") WHERE "status" = 'visible';--> statement-breakpoint
CREATE INDEX "comments_user" ON "comments" USING btree ("user_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "comments_body_hash" ON "comments" USING btree ("user_id","body_hash");