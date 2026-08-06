CREATE TYPE "public"."loyalty_transaction_kind" AS ENUM('earn', 'redeem', 'adjust', 'expire');--> statement-breakpoint
CREATE TYPE "public"."promotion_kind" AS ENUM('percentage', 'fixed', 'bogo', 'free_item');--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"birth_date" timestamp with time zone,
	"tier_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "loyalty_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_points" integer DEFAULT 0 NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loyalty_tiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "loyalty_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "loyalty_transaction_kind" NOT NULL,
	"points" integer NOT NULL,
	"reason" text NOT NULL,
	"session_id" uuid,
	"idempotency_key" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotion_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"promotion_id" uuid,
	"voucher_id" uuid,
	"customer_id" uuid,
	"name_snapshot" text NOT NULL,
	"discount_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "promotion_kind" NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_stackable" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"days_of_week" smallint[] DEFAULT '{}' NOT NULL,
	"start_time" time,
	"end_time" time,
	"branch_ids" uuid[] DEFAULT '{}' NOT NULL,
	"min_spend_minor" integer DEFAULT 0 NOT NULL,
	"category_ids" uuid[] DEFAULT '{}' NOT NULL,
	"menu_item_ids" uuid[] DEFAULT '{}' NOT NULL,
	"min_quantity" integer DEFAULT 0 NOT NULL,
	"required_tier_id" uuid,
	"requires_voucher" boolean DEFAULT false NOT NULL,
	"max_usage_total" integer,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promotions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"promotion_id" uuid NOT NULL,
	"code" text NOT NULL,
	"max_redemptions" integer DEFAULT 1 NOT NULL,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"customer_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vouchers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tier_id_loyalty_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."loyalty_tiers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_tiers" ADD CONSTRAINT "loyalty_tiers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_restaurant_phone_key" ON "customers" USING btree ("restaurant_id","phone");--> statement-breakpoint
CREATE INDEX "customers_restaurant_idx" ON "customers" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "customers_tier_idx" ON "customers" USING btree ("tier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_tiers_restaurant_name_key" ON "loyalty_tiers" USING btree ("restaurant_id","name");--> statement-breakpoint
CREATE INDEX "loyalty_tiers_threshold_idx" ON "loyalty_tiers" USING btree ("restaurant_id","min_points");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_transactions_idempotency_key" ON "loyalty_transactions" USING btree ("restaurant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_customer_idx" ON "loyalty_transactions" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_restaurant_idx" ON "loyalty_transactions" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_session_idx" ON "promotion_redemptions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_promotion_idx" ON "promotion_redemptions" USING btree ("promotion_id");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_restaurant_idx" ON "promotion_redemptions" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_restaurant_name_key" ON "promotions" USING btree ("restaurant_id","name");--> statement-breakpoint
CREATE INDEX "promotions_active_idx" ON "promotions" USING btree ("restaurant_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_restaurant_code_key" ON "vouchers" USING btree ("restaurant_id","code");--> statement-breakpoint
CREATE INDEX "vouchers_promotion_idx" ON "vouchers" USING btree ("promotion_id");--> statement-breakpoint
CREATE POLICY "customers_tenant_isolation" ON "customers" AS PERMISSIVE FOR ALL TO "evoapp" USING ("customers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("customers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "loyalty_tiers_tenant_isolation" ON "loyalty_tiers" AS PERMISSIVE FOR ALL TO "evoapp" USING ("loyalty_tiers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("loyalty_tiers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "loyalty_transactions_tenant_isolation" ON "loyalty_transactions" AS PERMISSIVE FOR ALL TO "evoapp" USING ("loyalty_transactions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("loyalty_transactions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_redemptions_tenant_isolation" ON "promotion_redemptions" AS PERMISSIVE FOR ALL TO "evoapp" USING ("promotion_redemptions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("promotion_redemptions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotions_tenant_isolation" ON "promotions" AS PERMISSIVE FOR ALL TO "evoapp" USING ("promotions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("promotions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotions_diner_read" ON "promotions" AS PERMISSIVE FOR SELECT TO "evoapp" USING ("promotions"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "vouchers_tenant_isolation" ON "vouchers" AS PERMISSIVE FOR ALL TO "evoapp" USING ("vouchers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("vouchers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);