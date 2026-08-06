CREATE TABLE "floors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "floors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "floors" ADD CONSTRAINT "floors_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floors" ADD CONSTRAINT "floors_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "floors_branch_name_key" ON "floors" USING btree ("branch_id","name");--> statement-breakpoint
CREATE INDEX "floors_branch_id_idx" ON "floors" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "floors_restaurant_id_idx" ON "floors" USING btree ("restaurant_id");--> statement-breakpoint
CREATE POLICY "floors_tenant_isolation" ON "floors" AS PERMISSIVE FOR ALL TO "ros_app" USING ("floors"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("floors"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);