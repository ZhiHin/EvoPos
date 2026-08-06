CREATE TYPE "public"."purchase_order_status" AS ENUM('draft', 'approved', 'partially_received', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_kind" AS ENUM('receipt', 'consumption', 'return', 'wastage', 'count', 'transfer_out', 'transfer_in');--> statement-breakpoint
CREATE TYPE "public"."stock_unit" AS ENUM('kg', 'l', 'each');--> statement-breakpoint
CREATE TABLE "ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"unit" "stock_unit" NOT NULL,
	"cost_per_unit_minor" integer DEFAULT 0 NOT NULL,
	"reorder_point_milli" integer DEFAULT 0 NOT NULL,
	"reorder_quantity_milli" integer DEFAULT 0 NOT NULL,
	"preferred_supplier_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingredients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"name_snapshot" text NOT NULL,
	"unit_snapshot" "stock_unit" NOT NULL,
	"ordered_milli" integer NOT NULL,
	"received_milli" integer DEFAULT 0 NOT NULL,
	"unit_cost_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
	"expected_at" timestamp with time zone,
	"notes" text,
	"total_minor" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recipe_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"menu_item_id" uuid,
	"modifier_option_id" uuid,
	"ingredient_id" uuid NOT NULL,
	"quantity_milli" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recipe_components" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"quantity_milli" integer DEFAULT 0 NOT NULL,
	"last_counted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_levels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"quantity_milli" integer NOT NULL,
	"cost_per_unit_minor" integer DEFAULT 0 NOT NULL,
	"value_minor" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"session_id" uuid,
	"order_line_id" uuid,
	"purchase_order_id" uuid,
	"idempotency_key" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"phone" text,
	"email" text,
	"address" text,
	"payment_term_days" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_preferred_supplier_id_suppliers_id_fk" FOREIGN KEY ("preferred_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_modifier_option_id_modifier_options_id_fk" FOREIGN KEY ("modifier_option_id") REFERENCES "public"."modifier_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingredients_restaurant_name_key" ON "ingredients" USING btree ("restaurant_id","name");--> statement-breakpoint
CREATE INDEX "ingredients_supplier_idx" ON "ingredients" USING btree ("preferred_supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_order_ingredient_key" ON "purchase_order_lines" USING btree ("purchase_order_id","ingredient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_restaurant_reference_key" ON "purchase_orders" USING btree ("restaurant_id","reference");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("restaurant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_components_item_ingredient_key" ON "recipe_components" USING btree ("menu_item_id","ingredient_id") WHERE menu_item_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_components_option_ingredient_key" ON "recipe_components" USING btree ("modifier_option_id","ingredient_id") WHERE modifier_option_id is not null;--> statement-breakpoint
CREATE INDEX "recipe_components_ingredient_idx" ON "recipe_components" USING btree ("ingredient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_levels_branch_ingredient_key" ON "stock_levels" USING btree ("branch_id","ingredient_id");--> statement-breakpoint
CREATE INDEX "stock_levels_ingredient_idx" ON "stock_levels" USING btree ("ingredient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_idempotency_key" ON "stock_movements" USING btree ("restaurant_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX "stock_movements_branch_ingredient_idx" ON "stock_movements" USING btree ("branch_id","ingredient_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_session_idx" ON "stock_movements" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_restaurant_name_key" ON "suppliers" USING btree ("restaurant_id","name");--> statement-breakpoint
CREATE POLICY "ingredients_tenant_isolation" ON "ingredients" AS PERMISSIVE FOR ALL TO "evoapp" USING ("ingredients"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("ingredients"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "purchase_order_lines_tenant_isolation" ON "purchase_order_lines" AS PERMISSIVE FOR ALL TO "evoapp" USING ("purchase_order_lines"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("purchase_order_lines"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "purchase_orders_tenant_isolation" ON "purchase_orders" AS PERMISSIVE FOR ALL TO "evoapp" USING ("purchase_orders"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("purchase_orders"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "recipe_components_tenant_isolation" ON "recipe_components" AS PERMISSIVE FOR ALL TO "evoapp" USING ("recipe_components"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("recipe_components"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stock_levels_tenant_isolation" ON "stock_levels" AS PERMISSIVE FOR ALL TO "evoapp" USING ("stock_levels"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("stock_levels"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stock_movements_tenant_isolation" ON "stock_movements" AS PERMISSIVE FOR ALL TO "evoapp" USING ("stock_movements"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("stock_movements"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "suppliers_tenant_isolation" ON "suppliers" AS PERMISSIVE FOR ALL TO "evoapp" USING ("suppliers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("suppliers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);