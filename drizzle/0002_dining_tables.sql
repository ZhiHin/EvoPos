CREATE TYPE "public"."table_status" AS ENUM('available', 'occupied', 'reserved', 'out_of_service');--> statement-breakpoint
CREATE TABLE "dining_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"floor_id" uuid,
	"code" text NOT NULL,
	"name" text,
	"capacity" integer DEFAULT 2 NOT NULL,
	"status" "table_status" DEFAULT 'available' NOT NULL,
	"qr_token" text NOT NULL,
	"qr_rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"position_x" integer,
	"position_y" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dining_tables" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dining_tables_qr_token_key" ON "dining_tables" USING btree ("qr_token");--> statement-breakpoint
CREATE UNIQUE INDEX "dining_tables_branch_code_key" ON "dining_tables" USING btree ("branch_id","code");--> statement-breakpoint
CREATE INDEX "dining_tables_branch_id_idx" ON "dining_tables" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "dining_tables_floor_id_idx" ON "dining_tables" USING btree ("floor_id");--> statement-breakpoint
CREATE INDEX "dining_tables_restaurant_id_idx" ON "dining_tables" USING btree ("restaurant_id");--> statement-breakpoint
CREATE POLICY "branches_qr_lookup" ON "branches" AS PERMISSIVE FOR SELECT TO "ros_app" USING (exists (
        select 1
        from dining_tables dt
        where dt.branch_id = "branches"."id"
          and dt.qr_token = nullif(current_setting('app.qr_token', true), '')
      ));--> statement-breakpoint
CREATE POLICY "restaurants_qr_lookup" ON "restaurants" AS PERMISSIVE FOR SELECT TO "ros_app" USING (exists (
        select 1
        from dining_tables dt
        where dt.restaurant_id = "restaurants"."id"
          and dt.qr_token = nullif(current_setting('app.qr_token', true), '')
      ));--> statement-breakpoint
CREATE POLICY "dining_tables_tenant_isolation" ON "dining_tables" AS PERMISSIVE FOR ALL TO "ros_app" USING ("dining_tables"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("dining_tables"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "dining_tables_qr_lookup" ON "dining_tables" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("dining_tables"."qr_token" = nullif(current_setting('app.qr_token', true), ''));