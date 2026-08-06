CREATE TYPE "public"."dining_session_status" AS ENUM('open', 'bill_requested', 'closed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."order_line_status" AS ENUM('pending', 'preparing', 'ready', 'served', 'voided');--> statement-breakpoint
CREATE TYPE "public"."service_request_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."service_request_type" AS ENUM('call_waiter', 'request_bill');--> statement-breakpoint
CREATE TABLE "dining_session_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dining_session_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "dining_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"status" "dining_session_status" DEFAULT 'open' NOT NULL,
	"opened_by_user_id" uuid,
	"guest_count" integer,
	"notes" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dining_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_line_modifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"modifier_option_id" uuid,
	"group_name_snapshot" text NOT NULL,
	"option_name_snapshot" text NOT NULL,
	"price_delta_minor" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_line_modifiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"member_id" uuid,
	"menu_item_id" uuid,
	"combo_id" uuid,
	"name_snapshot" text NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"line_total_minor" integer NOT NULL,
	"status" "order_line_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"member_id" uuid,
	"type" "service_request_type" NOT NULL,
	"status" "service_request_status" DEFAULT 'open' NOT NULL,
	"note" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dining_session_members" ADD CONSTRAINT "dining_session_members_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_session_members" ADD CONSTRAINT "dining_session_members_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_table_id_dining_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."dining_tables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_modifier_option_id_modifier_options_id_fk" FOREIGN KEY ("modifier_option_id") REFERENCES "public"."modifier_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_member_id_dining_session_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."dining_session_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_combo_id_combos_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."combos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_member_id_dining_session_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."dining_session_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dining_session_members_token_key" ON "dining_session_members" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "dining_session_members_session_idx" ON "dining_session_members" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "dining_session_members_restaurant_idx" ON "dining_session_members" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dining_sessions_one_open_per_table" ON "dining_sessions" USING btree ("table_id") WHERE status in ('open', 'bill_requested');--> statement-breakpoint
CREATE INDEX "dining_sessions_restaurant_status_idx" ON "dining_sessions" USING btree ("restaurant_id","status");--> statement-breakpoint
CREATE INDEX "dining_sessions_branch_idx" ON "dining_sessions" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "dining_sessions_table_idx" ON "dining_sessions" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "order_line_modifiers_line_idx" ON "order_line_modifiers" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "order_line_modifiers_session_idx" ON "order_line_modifiers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "order_line_modifiers_restaurant_idx" ON "order_line_modifiers" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "order_lines_session_idx" ON "order_lines" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "order_lines_member_idx" ON "order_lines" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "order_lines_restaurant_status_idx" ON "order_lines" USING btree ("restaurant_id","status");--> statement-breakpoint
CREATE INDEX "service_requests_session_idx" ON "service_requests" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "service_requests_open_idx" ON "service_requests" USING btree ("restaurant_id","status") WHERE status = 'open';--> statement-breakpoint
CREATE POLICY "menu_categories_diner_read" ON "menu_categories" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("menu_categories"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_item_tags_diner_read" ON "menu_item_tags" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("menu_item_tags"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_items_diner_read" ON "menu_items" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("menu_items"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_tags_diner_read" ON "menu_tags" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("menu_tags"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "combo_group_items_diner_read" ON "combo_group_items" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("combo_group_items"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "combo_groups_diner_read" ON "combo_groups" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("combo_groups"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "combos_diner_read" ON "combos" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("combos"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "menu_item_modifier_groups_diner_read" ON "menu_item_modifier_groups" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("menu_item_modifier_groups"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "modifier_groups_diner_read" ON "modifier_groups" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("modifier_groups"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "modifier_options_diner_read" ON "modifier_options" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("modifier_options"."restaurant_id" = nullif(current_setting('app.diner_tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "dining_session_members_tenant_isolation" ON "dining_session_members" AS PERMISSIVE FOR ALL TO "ros_app" USING ("dining_session_members"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("dining_session_members"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "dining_session_members_token_lookup" ON "dining_session_members" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("dining_session_members"."token_hash" = nullif(current_setting('app.member_token', true), ''));--> statement-breakpoint
CREATE POLICY "dining_session_members_peers_read" ON "dining_session_members" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("dining_session_members"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "dining_sessions_tenant_isolation" ON "dining_sessions" AS PERMISSIVE FOR ALL TO "ros_app" USING ("dining_sessions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("dining_sessions"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "dining_sessions_member_read" ON "dining_sessions" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("dining_sessions"."id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_line_modifiers_tenant_isolation" ON "order_line_modifiers" AS PERMISSIVE FOR ALL TO "ros_app" USING ("order_line_modifiers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("order_line_modifiers"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_line_modifiers_member_read" ON "order_line_modifiers" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("order_line_modifiers"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_line_modifiers_member_insert" ON "order_line_modifiers" AS PERMISSIVE FOR INSERT TO "ros_app" WITH CHECK ("order_line_modifiers"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_lines_tenant_isolation" ON "order_lines" AS PERMISSIVE FOR ALL TO "ros_app" USING ("order_lines"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("order_lines"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_lines_member_read" ON "order_lines" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("order_lines"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_lines_member_insert" ON "order_lines" AS PERMISSIVE FOR INSERT TO "ros_app" WITH CHECK ("order_lines"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "service_requests_tenant_isolation" ON "service_requests" AS PERMISSIVE FOR ALL TO "ros_app" USING ("service_requests"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("service_requests"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "service_requests_member_read" ON "service_requests" AS PERMISSIVE FOR SELECT TO "ros_app" USING ("service_requests"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "service_requests_member_insert" ON "service_requests" AS PERMISSIVE FOR INSERT TO "ros_app" WITH CHECK ("service_requests"."session_id" = nullif(current_setting('app.session_id', true), '')::uuid);