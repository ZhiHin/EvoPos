CREATE TYPE "public"."kitchen_station_kind" AS ENUM('food', 'beverage', 'dessert', 'other');--> statement-breakpoint
CREATE TYPE "public"."printer_kind" AS ENUM('kitchen', 'receipt', 'label');--> statement-breakpoint
CREATE TABLE "kitchen_stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "kitchen_station_kind" DEFAULT 'food' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kitchen_stations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "printer_kind" NOT NULL,
	"station_id" uuid,
	"connection" text,
	"characters_per_line" integer DEFAULT 42 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "printers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "receipt_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"header_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"footer_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"show_tax_number" boolean DEFAULT true NOT NULL,
	"show_qr_code" boolean DEFAULT false NOT NULL,
	"qr_caption" text,
	"characters_per_line" integer DEFAULT 42 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipt_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD COLUMN "kitchen_station_id" uuid;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "kitchen_station_id" uuid;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "kitchen_station_id" uuid;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "served_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_station_id_kitchen_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."kitchen_stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_templates" ADD CONSTRAINT "receipt_templates_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_stations_branch_name_key" ON "kitchen_stations" USING btree ("branch_id","name");--> statement-breakpoint
CREATE INDEX "kitchen_stations_branch_idx" ON "kitchen_stations" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "kitchen_stations_restaurant_idx" ON "kitchen_stations" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "printers_branch_name_key" ON "printers" USING btree ("branch_id","name");--> statement-breakpoint
CREATE INDEX "printers_branch_idx" ON "printers" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "printers_station_idx" ON "printers" USING btree ("station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_templates_restaurant_name_key" ON "receipt_templates" USING btree ("restaurant_id","name");--> statement-breakpoint
CREATE INDEX "receipt_templates_restaurant_idx" ON "receipt_templates" USING btree ("restaurant_id");--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_kitchen_station_id_kitchen_stations_id_fk" FOREIGN KEY ("kitchen_station_id") REFERENCES "public"."kitchen_stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_kitchen_station_id_kitchen_stations_id_fk" FOREIGN KEY ("kitchen_station_id") REFERENCES "public"."kitchen_stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_kitchen_station_id_kitchen_stations_id_fk" FOREIGN KEY ("kitchen_station_id") REFERENCES "public"."kitchen_stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "kitchen_stations_tenant_isolation" ON "kitchen_stations" AS PERMISSIVE FOR ALL TO "evoapp" USING ("kitchen_stations"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("kitchen_stations"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "printers_tenant_isolation" ON "printers" AS PERMISSIVE FOR ALL TO "evoapp" USING ("printers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("printers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "receipt_templates_tenant_isolation" ON "receipt_templates" AS PERMISSIVE FOR ALL TO "evoapp" USING ("receipt_templates"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("receipt_templates"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "receipt_templates_diner_read" ON "receipt_templates" AS PERMISSIVE FOR SELECT TO "evoapp" USING ("receipt_templates"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);