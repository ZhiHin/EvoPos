CREATE TYPE "public"."combo_status" AS ENUM('active', 'hidden', 'archived');--> statement-breakpoint
CREATE TYPE "public"."modifier_group_status" AS ENUM('active', 'hidden');--> statement-breakpoint
CREATE TABLE "combo_group_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"combo_group_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"price_delta_minor" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "combo_group_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "combo_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"combo_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_selection" integer DEFAULT 1 NOT NULL,
	"max_selection" integer,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "combo_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "combos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"base_price_minor" integer NOT NULL,
	"status" "combo_status" DEFAULT 'active' NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "combos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "menu_item_modifier_groups" (
	"menu_item_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"min_selection_override" integer,
	"max_selection_override" integer,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_modifier_groups_menu_item_id_modifier_group_id_pk" PRIMARY KEY("menu_item_id","modifier_group_id")
);
--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"min_selection" integer DEFAULT 0 NOT NULL,
	"max_selection" integer,
	"display_order" integer DEFAULT 0 NOT NULL,
	"status" "modifier_group_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "modifier_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "modifier_option_branches" (
	"modifier_option_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"is_available" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modifier_option_branches_modifier_option_id_branch_id_pk" PRIMARY KEY("modifier_option_id","branch_id")
);
--> statement-breakpoint
ALTER TABLE "modifier_option_branches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "modifier_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_delta_minor" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"max_quantity" integer DEFAULT 1 NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "modifier_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "combo_group_items" ADD CONSTRAINT "combo_group_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_group_items" ADD CONSTRAINT "combo_group_items_combo_group_id_combo_groups_id_fk" FOREIGN KEY ("combo_group_id") REFERENCES "public"."combo_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_group_items" ADD CONSTRAINT "combo_group_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_groups" ADD CONSTRAINT "combo_groups_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_groups" ADD CONSTRAINT "combo_groups_combo_id_combos_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."combos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combos" ADD CONSTRAINT "combos_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_modifier_group_id_modifier_groups_id_fk" FOREIGN KEY ("modifier_group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_option_branches" ADD CONSTRAINT "modifier_option_branches_modifier_option_id_modifier_options_id_fk" FOREIGN KEY ("modifier_option_id") REFERENCES "public"."modifier_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_option_branches" ADD CONSTRAINT "modifier_option_branches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_option_branches" ADD CONSTRAINT "modifier_option_branches_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_id_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "combo_group_items_group_item_key" ON "combo_group_items" USING btree ("combo_group_id","menu_item_id");--> statement-breakpoint
CREATE INDEX "combo_group_items_group_idx" ON "combo_group_items" USING btree ("combo_group_id");--> statement-breakpoint
CREATE INDEX "combo_group_items_menu_item_idx" ON "combo_group_items" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "combo_group_items_restaurant_id_idx" ON "combo_group_items" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "combo_groups_combo_name_key" ON "combo_groups" USING btree ("combo_id","name");--> statement-breakpoint
CREATE INDEX "combo_groups_combo_id_idx" ON "combo_groups" USING btree ("combo_id");--> statement-breakpoint
CREATE INDEX "combo_groups_restaurant_id_idx" ON "combo_groups" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "combos_restaurant_name_key" ON "combos" USING btree ("restaurant_id","name");--> statement-breakpoint
CREATE INDEX "combos_restaurant_id_idx" ON "combos" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "menu_item_modifier_groups_group_idx" ON "menu_item_modifier_groups" USING btree ("modifier_group_id");--> statement-breakpoint
CREATE INDEX "menu_item_modifier_groups_restaurant_id_idx" ON "menu_item_modifier_groups" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_groups_restaurant_name_key" ON "modifier_groups" USING btree ("restaurant_id","name");--> statement-breakpoint
CREATE INDEX "modifier_groups_restaurant_id_idx" ON "modifier_groups" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "modifier_option_branches_branch_idx" ON "modifier_option_branches" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "modifier_option_branches_restaurant_id_idx" ON "modifier_option_branches" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_options_group_name_key" ON "modifier_options" USING btree ("group_id","name");--> statement-breakpoint
CREATE INDEX "modifier_options_group_id_idx" ON "modifier_options" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "modifier_options_restaurant_id_idx" ON "modifier_options" USING btree ("restaurant_id");--> statement-breakpoint
CREATE POLICY "combo_group_items_tenant_isolation" ON "combo_group_items" AS PERMISSIVE FOR ALL TO "ros_app" USING ("combo_group_items"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("combo_group_items"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "combo_groups_tenant_isolation" ON "combo_groups" AS PERMISSIVE FOR ALL TO "ros_app" USING ("combo_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("combo_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "combos_tenant_isolation" ON "combos" AS PERMISSIVE FOR ALL TO "ros_app" USING ("combos"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("combos"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_item_modifier_groups_tenant_isolation" ON "menu_item_modifier_groups" AS PERMISSIVE FOR ALL TO "ros_app" USING ("menu_item_modifier_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("menu_item_modifier_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "modifier_groups_tenant_isolation" ON "modifier_groups" AS PERMISSIVE FOR ALL TO "ros_app" USING ("modifier_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("modifier_groups"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "modifier_option_branches_tenant_isolation" ON "modifier_option_branches" AS PERMISSIVE FOR ALL TO "ros_app" USING ("modifier_option_branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("modifier_option_branches"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "modifier_options_tenant_isolation" ON "modifier_options" AS PERMISSIVE FOR ALL TO "ros_app" USING ("modifier_options"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("modifier_options"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);