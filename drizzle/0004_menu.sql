CREATE TYPE "public"."menu_attribute_type" AS ENUM('text', 'number', 'boolean', 'select', 'multiselect');--> statement-breakpoint
CREATE TYPE "public"."menu_category_status" AS ENUM('active', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."menu_item_status" AS ENUM('active', 'hidden', 'archived');--> statement-breakpoint
CREATE TYPE "public"."menu_tag_kind" AS ENUM('label', 'allergen', 'dietary');--> statement-breakpoint
CREATE TABLE "menu_attribute_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "menu_attribute_type" NOT NULL,
	"options" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "menu_attribute_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"status" "menu_category_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_categories_parent_name_key" UNIQUE NULLS NOT DISTINCT("restaurant_id","parent_id","name")
);
--> statement-breakpoint
ALTER TABLE "menu_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "menu_item_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "menu_item_availability" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "menu_item_branches" (
	"menu_item_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_branches_menu_item_id_branch_id_pk" PRIMARY KEY("menu_item_id","branch_id")
);
--> statement-breakpoint
ALTER TABLE "menu_item_branches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "menu_item_tags" (
	"menu_item_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_tags_menu_item_id_tag_id_pk" PRIMARY KEY("menu_item_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "menu_item_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"category_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"price_minor" integer NOT NULL,
	"cost_price_minor" integer,
	"tax_rate_basis_points" integer,
	"service_charge_basis_points" integer,
	"sku" text,
	"barcode" text,
	"calories" integer,
	"prep_time_minutes" integer,
	"ingredients_text" text,
	"status" "menu_item_status" DEFAULT 'active' NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "menu_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"kind" "menu_tag_kind" DEFAULT 'label' NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "menu_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_attribute_definitions" ADD CONSTRAINT "menu_attribute_definitions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_parent_id_menu_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."menu_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_availability" ADD CONSTRAINT "menu_item_availability_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_availability" ADD CONSTRAINT "menu_item_availability_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_branches" ADD CONSTRAINT "menu_item_branches_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_branches" ADD CONSTRAINT "menu_item_branches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_branches" ADD CONSTRAINT "menu_item_branches_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_tags" ADD CONSTRAINT "menu_item_tags_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_tags" ADD CONSTRAINT "menu_item_tags_tag_id_menu_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."menu_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_tags" ADD CONSTRAINT "menu_item_tags_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_menu_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_tags" ADD CONSTRAINT "menu_tags_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "menu_attribute_definitions_key_key" ON "menu_attribute_definitions" USING btree ("restaurant_id","key");--> statement-breakpoint
CREATE INDEX "menu_attribute_definitions_restaurant_id_idx" ON "menu_attribute_definitions" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "menu_categories_restaurant_id_idx" ON "menu_categories" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "menu_categories_parent_id_idx" ON "menu_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "menu_item_availability_item_idx" ON "menu_item_availability" USING btree ("menu_item_id","day_of_week");--> statement-breakpoint
CREATE INDEX "menu_item_availability_restaurant_id_idx" ON "menu_item_availability" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "menu_item_branches_branch_id_idx" ON "menu_item_branches" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "menu_item_branches_restaurant_id_idx" ON "menu_item_branches" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "menu_item_tags_tag_id_idx" ON "menu_item_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "menu_item_tags_restaurant_id_idx" ON "menu_item_tags" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_items_restaurant_sku_key" ON "menu_items" USING btree ("restaurant_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_items_restaurant_barcode_key" ON "menu_items" USING btree ("restaurant_id","barcode");--> statement-breakpoint
CREATE INDEX "menu_items_restaurant_id_idx" ON "menu_items" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "menu_items_category_id_idx" ON "menu_items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "menu_items_status_idx" ON "menu_items" USING btree ("restaurant_id","status");--> statement-breakpoint
CREATE INDEX "menu_items_attributes_idx" ON "menu_items" USING gin ("attributes");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_tags_restaurant_kind_name_key" ON "menu_tags" USING btree ("restaurant_id","kind","name");--> statement-breakpoint
CREATE INDEX "menu_tags_restaurant_id_idx" ON "menu_tags" USING btree ("restaurant_id");--> statement-breakpoint
CREATE POLICY "menu_attribute_definitions_tenant_isolation" ON "menu_attribute_definitions" AS PERMISSIVE FOR ALL TO "ros_app" USING ("menu_attribute_definitions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_attribute_definitions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_categories_tenant_isolation" ON "menu_categories" AS PERMISSIVE FOR ALL TO "ros_app" USING ("menu_categories"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_categories"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_item_availability_tenant_isolation" ON "menu_item_availability" AS PERMISSIVE FOR ALL TO "ros_app" USING ("menu_item_availability"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_item_availability"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_item_branches_tenant_isolation" ON "menu_item_branches" AS PERMISSIVE FOR ALL TO "ros_app" USING ("menu_item_branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_item_branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_item_tags_tenant_isolation" ON "menu_item_tags" AS PERMISSIVE FOR ALL TO "ros_app" USING ("menu_item_tags"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_item_tags"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_items_tenant_isolation" ON "menu_items" AS PERMISSIVE FOR ALL TO "ros_app" USING ("menu_items"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_items"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_tags_tenant_isolation" ON "menu_tags" AS PERMISSIVE FOR ALL TO "ros_app" USING ("menu_tags"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_tags"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);