CREATE TYPE "public"."dining_session_type" AS ENUM('dine_in', 'takeaway', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."session_discount_type" AS ENUM('percentage', 'fixed');--> statement-breakpoint
CREATE TABLE "session_discounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"type" "session_discount_type" NOT NULL,
	"value" integer NOT NULL,
	"reason" text NOT NULL,
	"applied_by_user_id" uuid,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_discounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dining_sessions" ALTER COLUMN "table_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_sessions" ADD COLUMN "type" "dining_session_type" DEFAULT 'dine_in' NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_sessions" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "dining_sessions" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "dining_sessions" ADD COLUMN "delivery_address" text;--> statement-breakpoint
ALTER TABLE "session_discounts" ADD CONSTRAINT "session_discounts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_discounts" ADD CONSTRAINT "session_discounts_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_discounts" ADD CONSTRAINT "session_discounts_applied_by_user_id_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_discounts" ADD CONSTRAINT "session_discounts_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_discounts_session_idx" ON "session_discounts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_discounts_restaurant_idx" ON "session_discounts" USING btree ("restaurant_id");--> statement-breakpoint
CREATE POLICY "session_discounts_tenant_isolation" ON "session_discounts" AS PERMISSIVE FOR ALL TO "ros_app" USING ("session_discounts"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("session_discounts"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "session_discounts_member_read" ON "session_discounts" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("session_discounts"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);