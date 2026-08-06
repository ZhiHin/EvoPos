CREATE TYPE "public"."bill_split_status" AS ENUM('locked', 'void');--> statement-breakpoint
CREATE TYPE "public"."bill_split_strategy" AS ENUM('by_owner', 'even', 'by_percentage', 'by_item');--> statement-breakpoint
CREATE TABLE "bill_split_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"split_id" uuid NOT NULL,
	"member_id" uuid,
	"display_name_snapshot" text NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"discount_minor" integer NOT NULL,
	"service_charge_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"line_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bill_split_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bill_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"strategy" "bill_split_strategy" NOT NULL,
	"status" "bill_split_status" DEFAULT 'locked' NOT NULL,
	"bill_total_minor" integer NOT NULL,
	"locked_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bill_splits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bill_split_shares" ADD CONSTRAINT "bill_split_shares_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_split_shares" ADD CONSTRAINT "bill_split_shares_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_split_shares" ADD CONSTRAINT "bill_split_shares_split_id_bill_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."bill_splits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_split_shares" ADD CONSTRAINT "bill_split_shares_member_id_dining_session_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."dining_session_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_splits" ADD CONSTRAINT "bill_splits_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_splits" ADD CONSTRAINT "bill_splits_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_splits" ADD CONSTRAINT "bill_splits_locked_by_user_id_users_id_fk" FOREIGN KEY ("locked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_splits" ADD CONSTRAINT "bill_splits_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_split_shares_split_idx" ON "bill_split_shares" USING btree ("split_id");--> statement-breakpoint
CREATE INDEX "bill_split_shares_session_idx" ON "bill_split_shares" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "bill_split_shares_member_idx" ON "bill_split_shares" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "bill_split_shares_restaurant_idx" ON "bill_split_shares" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_splits_one_locked_per_session" ON "bill_splits" USING btree ("session_id") WHERE status = 'locked';--> statement-breakpoint
CREATE INDEX "bill_splits_session_idx" ON "bill_splits" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "bill_splits_restaurant_idx" ON "bill_splits" USING btree ("restaurant_id");--> statement-breakpoint
CREATE POLICY "bill_split_shares_tenant_isolation" ON "bill_split_shares" AS PERMISSIVE FOR ALL TO "evoapp" USING ("bill_split_shares"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("bill_split_shares"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bill_split_shares_member_read" ON "bill_split_shares" AS PERMISSIVE FOR SELECT TO "evoapp" USING ("bill_split_shares"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bill_splits_tenant_isolation" ON "bill_splits" AS PERMISSIVE FOR ALL TO "evoapp" USING ("bill_splits"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("bill_splits"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bill_splits_member_read" ON "bill_splits" AS PERMISSIVE FOR SELECT TO "evoapp" USING ("bill_splits"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);