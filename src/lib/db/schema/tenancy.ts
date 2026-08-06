import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import {
  appRole,
  currentActorId,
  currentQrToken,
  tenantPolicy,
  timestamps,
} from './_shared'

/**
 * Tenancy root.
 *
 * A restaurant IS the tenant. Its primary key is the value carried in
 * `app.tenant_id` and compared by every policy in the system, so there is no
 * separate tenant table to drift out of sync with it.
 *
 *   restaurant -> branch -> (floors, tables, orders, ... in later phases)
 */

export const subscriptionPlan = pgEnum('subscription_plan', [
  'launch',
  'grow',
  'scale',
  'enterprise',
])

export const restaurantStatus = pgEnum('restaurant_status', [
  'active',
  'suspended',
  'cancelled',
])

export const restaurants = pgTable(
  'restaurants',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: text('name').notNull(),
    /** Globally unique; used for tenant-scoped URLs and QR payloads. */
    slug: text('slug').notNull(),

    plan: subscriptionPlan('plan').notNull().default('launch'),
    status: restaurantStatus('status').notNull().default('active'),

    /** ISO 4217. Money is stored in minor units against this currency. */
    currency: text('currency').notNull().default('MYR'),
    /** IANA zone. Branches may override; this is the fallback. */
    timezone: text('timezone').notNull().default('Asia/Kuala_Lumpur'),
    locale: text('locale').notNull().default('en'),

    /**
     * Tax and service charge as integer basis points: 600 = 6.00%.
     *
     * Not a float, and not `numeric` in application code. A 6% tax on a
     * RM 23.45 bill computed in floating point lands a cent out often enough
     * that a day's takings fail to reconcile — and reconciliation failures
     * are how a restaurant stops trusting its POS. Integers throughout, with
     * rounding decided explicitly at the point of calculation in Phase 6.
     */
    taxRateBasisPoints: integer('tax_rate_basis_points').notNull().default(0),
    serviceChargeBasisPoints: integer('service_charge_basis_points')
      .notNull()
      .default(0),

    /**
     * True when menu prices already include tax, as is normal in Malaysia.
     * Decides whether tax is added to the subtotal or extracted from it, so
     * it must be explicit rather than assumed.
     */
    taxInclusive: boolean('tax_inclusive').notNull().default(false),

    logoUrl: text('logo_url'),
    taxRegistrationNumber: text('tax_registration_number'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('restaurants_slug_key').on(t.slug),

    /** Full access while operating inside this restaurant. */
    tenantPolicy('restaurants_tenant_isolation', t.id),

    /**
     * Read-only escape hatch for the tenant switcher.
     *
     * After login the user has no active restaurant yet, so there is no
     * tenant context to satisfy the policy above -- yet we still have to list
     * the restaurants they may switch into. This grants exactly that: SELECT
     * on restaurants where the actor holds a membership, and nothing more.
     * Writes remain confined to the active tenant.
     *
     * The subquery is itself filtered by the policies on `memberships`, whose
     * self-read policy matches on user_id and does not reference
     * `restaurants` -- so this does not recurse.
     */
    pgPolicy('restaurants_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`exists (
        select 1
        from memberships m
        where m.restaurant_id = ${t.id}
          and m.user_id = ${currentActorId()}
          and m.status = 'active'
      )`,
    }),

    /**
     * Lets a QR scan read the restaurant name for the one table it holds a
     * token for, so the scan page can say "Kopi Corner · Bangsar · Table 12".
     *
     * This must be added together with `branches_qr_lookup` and
     * `dining_tables_qr_lookup` -- the scan query inner-joins all three, and
     * a missing policy on any one of them makes the join match nothing. That
     * is the same failure `roles_member_read` was added to fix in Phase 0.
     *
     * Scoped through `dining_tables`, whose own QR policy matches on the
     * token and does not reference `restaurants`, so there is no recursion.
     */
    pgPolicy('restaurants_qr_lookup', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`exists (
        select 1
        from dining_tables dt
        where dt.restaurant_id = ${t.id}
          and dt.qr_token = ${currentQrToken()}
      )`,
    }),
  ],
)

export const branchStatus = pgEnum('branch_status', ['active', 'inactive'])

export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** Short human code shown on receipts and reports, e.g. "KL01". */
    code: text('code').notNull(),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country'),
    phone: text('phone'),

    /** Overrides the restaurant timezone when set. */
    timezone: text('timezone'),

    status: branchStatus('status').notNull().default('active'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('branches_restaurant_code_key').on(t.restaurantId, t.code),
    index('branches_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('branches_tenant_isolation', t.restaurantId),

    /** Counterpart to `restaurants_qr_lookup`; see the note there. */
    pgPolicy('branches_qr_lookup', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`exists (
        select 1
        from dining_tables dt
        where dt.branch_id = ${t.id}
          and dt.qr_token = ${currentQrToken()}
      )`,
    }),
  ],
)

export const restaurantsRelations = relations(restaurants, ({ many }) => ({
  branches: many(branches),
}))

export const branchesRelations = relations(branches, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [branches.restaurantId],
    references: [restaurants.id],
  }),
}))
