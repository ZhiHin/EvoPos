CREATE TABLE "sales_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"type" "dining_session_type" NOT NULL,
	"covers" integer,
	"subtotal_minor" integer NOT NULL,
	"discount_minor" integer NOT NULL,
	"service_charge_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"paid_minor" integer NOT NULL,
	"tax_rate_basis_points" integer NOT NULL,
	"service_charge_basis_points" integer NOT NULL,
	"tax_is_included" boolean NOT NULL,
	"cost_minor" integer DEFAULT 0 NOT NULL,
	"costed_subtotal_minor" integer DEFAULT 0 NOT NULL,
	"customer_id" uuid,
	"settled_by_user_id" uuid,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "business_day_start_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_session_id_dining_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dining_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_settled_by_user_id_users_id_fk" FOREIGN KEY ("settled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_records_session_key" ON "sales_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sales_records_restaurant_settled_idx" ON "sales_records" USING btree ("restaurant_id","settled_at");--> statement-breakpoint
CREATE INDEX "sales_records_branch_settled_idx" ON "sales_records" USING btree ("branch_id","settled_at");--> statement-breakpoint
CREATE INDEX "sales_records_customer_idx" ON "sales_records" USING btree ("customer_id");--> statement-breakpoint
CREATE POLICY "sales_records_tenant_isolation" ON "sales_records" AS PERMISSIVE FOR ALL TO "evoapp" USING ("sales_records"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("sales_records"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);