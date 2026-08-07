CREATE TABLE "insight_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"insight_key" text NOT NULL,
	"reason" text NOT NULL,
	"snoozed_until" timestamp with time zone,
	"dismissed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "insight_dismissals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "insight_dismissals" ADD CONSTRAINT "insight_dismissals_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_dismissals" ADD CONSTRAINT "insight_dismissals_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "insight_dismissals_key" ON "insight_dismissals" USING btree ("restaurant_id","insight_key");--> statement-breakpoint
CREATE INDEX "insight_dismissals_snoozed_idx" ON "insight_dismissals" USING btree ("snoozed_until");--> statement-breakpoint
CREATE POLICY "insight_dismissals_tenant_isolation" ON "insight_dismissals" AS PERMISSIVE FOR ALL TO "evoapp" USING ("insight_dismissals"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("insight_dismissals"."restaurant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);