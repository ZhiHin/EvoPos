CREATE TYPE "public"."reservation_status" AS ENUM('pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."waitlist_status" AS ENUM('waiting', 'notified', 'seated', 'left');--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"shift_id" uuid,
	"clock_in_at" timestamp with time zone NOT NULL,
	"clock_out_at" timestamp with time zone,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"lateness_minutes" integer DEFAULT 0 NOT NULL,
	"edited_by_user_id" uuid,
	"edited_at" timestamp with time zone,
	"edit_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid,
	"guest_name" text NOT NULL,
	"guest_phone" text,
	"guest_email" text,
	"party_size" smallint NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"table_id" uuid,
	"status" "reservation_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"occasion" text,
	"session_id" uuid,
	"seated_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"position" text,
	"notes" text,
	"published_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid,
	"guest_name" text NOT NULL,
	"guest_phone" text,
	"party_size" smallint NOT NULL,
	"quoted_wait_minutes" integer DEFAULT 0 NOT NULL,
	"status" "waitlist_status" DEFAULT 'waiting' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"seated_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"session_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waitlist_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dining_sessions" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_table_id_dining_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."dining_tables"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_open_punch_key" ON "attendance_records" USING btree ("user_id") WHERE clock_out_at is null;--> statement-breakpoint
CREATE INDEX "attendance_user_window_idx" ON "attendance_records" USING btree ("user_id","clock_in_at");--> statement-breakpoint
CREATE INDEX "attendance_branch_window_idx" ON "attendance_records" USING btree ("branch_id","clock_in_at");--> statement-breakpoint
CREATE INDEX "reservations_table_window_idx" ON "reservations" USING btree ("table_id","starts_at");--> statement-breakpoint
CREATE INDEX "reservations_branch_window_idx" ON "reservations" USING btree ("restaurant_id","branch_id","starts_at");--> statement-breakpoint
CREATE INDEX "reservations_customer_idx" ON "reservations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "shifts_branch_window_idx" ON "shifts" USING btree ("branch_id","starts_at");--> statement-breakpoint
CREATE INDEX "shifts_user_window_idx" ON "shifts" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX "waitlist_branch_status_idx" ON "waitlist_entries" USING btree ("branch_id","status","joined_at");--> statement-breakpoint
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "attendance_records_tenant_isolation" ON "attendance_records" AS PERMISSIVE FOR ALL TO "evoapp" USING ("attendance_records"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("attendance_records"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "reservations_tenant_isolation" ON "reservations" AS PERMISSIVE FOR ALL TO "evoapp" USING ("reservations"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("reservations"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "shifts_tenant_isolation" ON "shifts" AS PERMISSIVE FOR ALL TO "evoapp" USING ("shifts"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("shifts"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "waitlist_entries_tenant_isolation" ON "waitlist_entries" AS PERMISSIVE FOR ALL TO "evoapp" USING ("waitlist_entries"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("waitlist_entries"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);