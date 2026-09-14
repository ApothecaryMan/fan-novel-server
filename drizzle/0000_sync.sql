CREATE TABLE "chapters" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chapters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"novel_id" varchar(100) NOT NULL,
	"chapter_number" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"content_raw" text,
	"word_count" integer DEFAULT 0,
	"views_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "novels" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"title" varchar(255) NOT NULL,
	"original_title" varchar(255),
	"author" varchar(150) NOT NULL,
	"translator" varchar(150),
	"status" varchar(50) DEFAULT 'مستمرة' NOT NULL,
	"category" varchar(100) NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rating" integer DEFAULT 50 NOT NULL,
	"readers_count" varchar(50) DEFAULT '0' NOT NULL,
	"total_chapters" integer DEFAULT 0 NOT NULL,
	"cover_url" text NOT NULL,
	"summary" text NOT NULL,
	"featured_rank" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reading_history" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reading_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"novel_id" varchar(100) NOT NULL,
	"novel_title" varchar(255) DEFAULT '' NOT NULL,
	"novel_cover" text DEFAULT '' NOT NULL,
	"novel_author" varchar(150) DEFAULT '' NOT NULL,
	"category" varchar(100) DEFAULT '' NOT NULL,
	"source_id" varchar(100),
	"chapter_id" integer NOT NULL,
	"chapter_number" integer NOT NULL,
	"chapter_title" varchar(255) DEFAULT '' NOT NULL,
	"progress_percent" real DEFAULT 0 NOT NULL,
	"read_day" varchar(10) NOT NULL,
	"read_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reading_sessions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reading_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"client_session_id" varchar(64) NOT NULL,
	"novel_id" varchar(100) NOT NULL,
	"chapter_id" integer NOT NULL,
	"seconds" integer NOT NULL,
	"words" integer NOT NULL,
	"minute_of_day" integer NOT NULL,
	"read_day" varchar(10) NOT NULL,
	"genre" varchar(100) DEFAULT '' NOT NULL,
	"ts" bigint NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_categories" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"is_system_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_library" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_library_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"novel_id" varchar(100) NOT NULL,
	"source_id" varchar(100),
	"category_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_read_chapter_id" integer,
	"last_read_chapter_number" integer,
	"last_read_chapter_title" varchar(255),
	"progress_percent" real DEFAULT 0 NOT NULL,
	"last_read_at" timestamp,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(255),
	"email" varchar(255),
	"username" varchar(100),
	"password_hash" text,
	"avatar_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_novel_id_novels_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_history" ADD CONSTRAINT "reading_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD CONSTRAINT "reading_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_categories" ADD CONSTRAINT "user_categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_library" ADD CONSTRAINT "user_library_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "novel_chapter_idx" ON "chapters" USING btree ("novel_id","chapter_number");--> statement-breakpoint
CREATE UNIQUE INDEX "history_user_novel_chapter_idx" ON "reading_history" USING btree ("user_id","novel_id","chapter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_user_client_idx" ON "reading_sessions" USING btree ("user_id","client_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_library_idx" ON "user_library" USING btree ("user_id","novel_id");