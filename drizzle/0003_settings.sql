ALTER TABLE "restaurants" ADD COLUMN "tax_rate_basis_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "service_charge_basis_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "tax_inclusive" boolean DEFAULT false NOT NULL;