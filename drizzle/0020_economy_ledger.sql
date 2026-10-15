CREATE TABLE "iap_purchases" (
	"purchase_token" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"sku" varchar(100) NOT NULL,
	"points_granted" integer NOT NULL,
	"currency" varchar(16) NOT NULL,
	"status" varchar(20) DEFAULT 'granted' NOT NULL,
	"refunded_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "iap_currency" CHECK ("iap_purchases"."currency" in ('free','pro'))
);
--> statement-breakpoint
CREATE TABLE "point_transactions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "point_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"currency" varchar(16) DEFAULT 'free' NOT NULL,
	"type" varchar(32) NOT NULL,
	"reference_type" varchar(64),
	"reference_id" varchar(128),
	"idempotency_key" varchar(128) NOT NULL,
	"reason" varchar(500),
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ptx_amount_nonzero" CHECK ("point_transactions"."amount" <> 0),
	CONSTRAINT "ptx_currency" CHECK ("point_transactions"."currency" in ('free','pro')),
	CONSTRAINT "ptx_type_check" CHECK ("point_transactions"."type" in ('reward','iap_purchase','spend','refund','admin_adjust'))
);
--> statement-breakpoint
CREATE TABLE "store_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" varchar(100) NOT NULL,
	"type" varchar(32) NOT NULL,
	"name" varchar(200) NOT NULL,
	"price_points" integer NOT NULL,
	"currency" varchar(16) DEFAULT 'free' NOT NULL,
	"rarity" varchar(32),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"available_from" timestamp with time zone,
	"available_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_items_sku_unique" UNIQUE("sku"),
	CONSTRAINT "store_items_price_positive" CHECK ("store_items"."price_points" > 0),
	CONSTRAINT "store_items_currency" CHECK ("store_items"."currency" in ('free','pro'))
);
--> statement-breakpoint
CREATE TABLE "user_coin_balances" (
	"user_id" uuid NOT NULL,
	"currency" varchar(16) NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_coin_balances_user_id_currency_pk" PRIMARY KEY("user_id","currency"),
	CONSTRAINT "ucb_currency" CHECK ("user_coin_balances"."currency" in ('free','pro'))
);
--> statement-breakpoint
CREATE TABLE "user_equipped" (
	"user_id" uuid NOT NULL,
	"slot" varchar(32) NOT NULL,
	"item_id" uuid NOT NULL,
	"equipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_equipped_user_id_slot_pk" PRIMARY KEY("user_id","slot")
);
--> statement-breakpoint
CREATE TABLE "user_inventory" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_inventory_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"source" varchar(32) NOT NULL,
	"price_paid" integer NOT NULL,
	"currency" varchar(16) NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inv_currency" CHECK ("user_inventory"."currency" in ('free','pro'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ptx_user_idem_uq" ON "point_transactions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ptx_user_created_idx" ON "point_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_user_item_uq" ON "user_inventory" USING btree ("user_id","item_id");--> statement-breakpoint
ALTER TABLE "iap_purchases" ADD CONSTRAINT "iap_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_coin_balances" ADD CONSTRAINT "user_coin_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_inventory" ADD CONSTRAINT "user_inventory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_inventory" ADD CONSTRAINT "user_inventory_item_id_store_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."store_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_equipped" ADD CONSTRAINT "user_equipped_user_id_item_id_user_inventory_user_id_item_id_fk" FOREIGN KEY ("user_id","item_id") REFERENCES "public"."user_inventory"("user_id","item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'point_transactions is append-only'; END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER point_transactions_append_only
BEFORE UPDATE OR DELETE ON "point_transactions"
FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();