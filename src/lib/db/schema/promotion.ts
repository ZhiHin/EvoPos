import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { diningSessions } from './session'
import { restaurants } from './tenancy'
import { users } from './identity'
import { dinerMenuReadPolicy, tenantPolicy, timestamps } from './_shared'

/**
 * Promotions, vouchers and loyalty.
 *
 * Conditions live in typed columns rather than a JSONB blob. Every one of
 * them is something an owner filters and reports on — "which promotions run
 * on Tuesdays", "what is live at this branch" — and those questions are
 * answerable in SQL against columns and painful against JSON.
 */

export const promotionKind = pgEnum('promotion_kind', [
  'percentage',
  'fixed',
  'bogo',
  'free_item',
])

export const promotions = pgTable(
  'promotions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),

    kind: promotionKind('kind').notNull(),
    /** Basis points for `percentage`, minor units for `fixed`. */
    value: integer('value').notNull().default(0),

    /** Lower runs first. */
    priority: integer('priority').notNull().default(100),
    /** False means it applies alone. See the engine for why one flag. */
    isStackable: boolean('is_stackable').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),

    // --- conditions ---
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    /** 0 = Sunday. Empty means every day. */
    daysOfWeek: smallint('days_of_week').array().notNull().default([]),
    startTime: time('start_time'),
    endTime: time('end_time'),
    /** Empty means every branch. Not FK-constrained — an array cannot be. */
    branchIds: uuid('branch_ids').array().notNull().default([]),
    minSpendMinor: integer('min_spend_minor').notNull().default(0),
    categoryIds: uuid('category_ids').array().notNull().default([]),
    menuItemIds: uuid('menu_item_ids').array().notNull().default([]),
    minQuantity: integer('min_quantity').notNull().default(0),
    requiredTierId: uuid('required_tier_id'),
    requiresVoucher: boolean('requires_voucher').notNull().default(false),

    /**
     * Null means unlimited. Decremented by a conditional UPDATE rather than
     * read-then-write, so a promotion capped at 100 cannot reach 101 when two
     * tills redeem it at the same instant.
     */
    maxUsageTotal: integer('max_usage_total'),
    usageCount: integer('usage_count').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('promotions_restaurant_name_key').on(t.restaurantId, t.name),
    index('promotions_active_idx').on(t.restaurantId, t.isActive),
    tenantPolicy('promotions_tenant_isolation', t.restaurantId),
    /** A diner's screen shows what they qualify for while they order. */
    dinerMenuReadPolicy('promotions_diner_read', t.restaurantId),
  ],
)

export const vouchers = pgTable(
  'vouchers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    promotionId: uuid('promotion_id')
      .notNull()
      .references(() => promotions.id, { onDelete: 'cascade' }),

    /** Uppercased on write so lookup is exact and case cannot confuse anyone. */
    code: text('code').notNull(),

    maxRedemptions: integer('max_redemptions').notNull().default(1),
    redemptionCount: integer('redemption_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    /** Set to bind a code to one person; null means bearer. */
    customerId: uuid('customer_id'),

    isActive: boolean('is_active').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('vouchers_restaurant_code_key').on(t.restaurantId, t.code),
    index('vouchers_promotion_idx').on(t.promotionId),
    tenantPolicy('vouchers_tenant_isolation', t.restaurantId),
  ],
)

export const loyaltyTiers = pgTable(
  'loyalty_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** Lifetime points needed to reach this tier. */
    minPoints: integer('min_points').notNull().default(0),
    displayOrder: integer('display_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('loyalty_tiers_restaurant_name_key').on(
      t.restaurantId,
      t.name,
    ),
    index('loyalty_tiers_threshold_idx').on(t.restaurantId, t.minPoints),
    tenantPolicy('loyalty_tiers_tenant_isolation', t.restaurantId),
  ],
)

/**
 * The loyalty account.
 *
 * Deliberately minimal — name, a way to reach them, their tier. Phase 11
 * extends this into a full CRM record with visit history, segmentation and
 * marketing tags. Building that here would mean designing the CRM before
 * knowing what the loyalty engine actually needs from it.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    birthDate: timestamp('birth_date', { withTimezone: true }),

    tierId: uuid('tier_id').references(() => loyaltyTiers.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
  },
  (t) => [
    /**
     * Phone is the practical identifier at a till — nobody spells an email
     * across a counter. Unique per restaurant, and nullable for walk-ins who
     * decline to give one.
     */
    uniqueIndex('customers_restaurant_phone_key').on(t.restaurantId, t.phone),
    index('customers_restaurant_idx').on(t.restaurantId),
    index('customers_tier_idx').on(t.tierId),
    tenantPolicy('customers_tenant_isolation', t.restaurantId),
  ],
)

export const loyaltyTransactionKind = pgEnum('loyalty_transaction_kind', [
  'earn',
  'redeem',
  'adjust',
  'expire',
])

/**
 * The points ledger — the only source of truth for a balance.
 *
 * There is no cached `pointsBalance` column on `customers`. A denormalised
 * balance is a second answer to the same question, and the two drift the
 * first time a write path forgets to update it. Summing a few hundred rows is
 * cheap; explaining to a customer why their balance is wrong is not.
 */
export const loyaltyTransactions = pgTable(
  'loyalty_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),

    kind: loyaltyTransactionKind('kind').notNull(),
    /** Signed: positive earns, negative redeems and expiries. */
    points: integer('points').notNull(),
    reason: text('reason').notNull(),

    sessionId: uuid('session_id').references(() => diningSessions.id, {
      onDelete: 'set null',
    }),

    /** Stops a bill earning points twice on a retry. */
    idempotencyKey: text('idempotency_key'),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('loyalty_transactions_idempotency_key').on(
      t.restaurantId,
      t.idempotencyKey,
    ),
    index('loyalty_transactions_customer_idx').on(t.customerId, t.createdAt),
    index('loyalty_transactions_restaurant_idx').on(t.restaurantId),
    tenantPolicy('loyalty_transactions_tenant_isolation', t.restaurantId),
  ],
)

/**
 * Which promotions actually fired on which bill.
 *
 * Recorded rather than recomputed, because "why was this bill discounted"
 * must stay answerable after the promotion has been edited or deleted.
 */
export const promotionRedemptions = pgTable(
  'promotion_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'cascade' }),

    promotionId: uuid('promotion_id').references(() => promotions.id, {
      onDelete: 'set null',
    }),
    voucherId: uuid('voucher_id').references(() => vouchers.id, {
      onDelete: 'set null',
    }),
    customerId: uuid('customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),

    /** Snapshots, so the record survives the promotion being changed. */
    nameSnapshot: text('name_snapshot').notNull(),
    discountMinor: integer('discount_minor').notNull(),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('promotion_redemptions_session_idx').on(t.sessionId),
    index('promotion_redemptions_promotion_idx').on(t.promotionId),
    index('promotion_redemptions_restaurant_idx').on(t.restaurantId),
    tenantPolicy('promotion_redemptions_tenant_isolation', t.restaurantId),
  ],
)

export const promotionsRelations = relations(promotions, ({ many }) => ({
  vouchers: many(vouchers),
  redemptions: many(promotionRedemptions),
}))

export const vouchersRelations = relations(vouchers, ({ one }) => ({
  promotion: one(promotions, {
    fields: [vouchers.promotionId],
    references: [promotions.id],
  }),
}))

export const customersRelations = relations(customers, ({ one, many }) => ({
  tier: one(loyaltyTiers, {
    fields: [customers.tierId],
    references: [loyaltyTiers.id],
  }),
  transactions: many(loyaltyTransactions),
}))

export const loyaltyTransactionsRelations = relations(
  loyaltyTransactions,
  ({ one }) => ({
    customer: one(customers, {
      fields: [loyaltyTransactions.customerId],
      references: [customers.id],
    }),
  }),
)
