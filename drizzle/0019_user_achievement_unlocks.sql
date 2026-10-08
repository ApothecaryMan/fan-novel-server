CREATE TABLE "user_achievement_unlocks" (
	"user_id" uuid NOT NULL,
	"achievement_id" varchar(100) NOT NULL,
	"level" smallint NOT NULL,
	"first_seen_at" bigint NOT NULL,
	"catalog_version" integer NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "user_achievement_unlocks_level_check" CHECK ("user_achievement_unlocks"."level" >= 2 AND "user_achievement_unlocks"."level" <= 6)
);
--> statement-breakpoint
ALTER TABLE "user_achievement_unlocks" ADD CONSTRAINT "user_achievement_unlocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_achievement_unlocks_pkey" ON "user_achievement_unlocks" USING btree ("user_id","achievement_id");