import { relations, sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { diningSessionMembers, diningSessions } from './session'
import { restaurants } from './tenancy'
import { users } from './identity'
import {
  appRole,
  currentSessionId,
  tenantPolicy,
  timestamps,
} from './_shared'

/**
 * Smart Bill — how a table's bill was divided.
 *
 * A split is a record of an agreement, not a calculation cached for speed.
 * Once locked its amounts never move again, which is what makes "leave
 * early" possible: someone settles RM 42.30 and walks out, and a later round
 * of drinks cannot retroactively change what they already agreed to pay.
 */

export const billSplitStrategy = pgEnum('bill_split_strategy', [
  'by_owner',
  'even',
  'by_percentage',
  'by_item',
])

export const billSplitStatus = pgEnum('bill_split_status', [
  'locked',
  'void',
])

export const billSplits = pgTable(
  'bill_splits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'cascade' }),

    strategy: billSplitStrategy('strategy').notNull(),
    status: billSplitStatus('status').notNull().default('locked'),

    /**
     * The bill total at the moment of locking. Kept so a later order making
     * the live total diverge is detectable — the difference is exactly the
     * amount still unaccounted for, which staff must settle separately.
     */
    billTotalMinor: integer('bill_total_minor').notNull(),

    lockedByUserId: uuid('locked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    voidReason: text('void_reason'),

    ...timestamps,
  },
  (t) => [
    /**
     * At most one live split per session, enforced by the database.
     *
     * Two cashiers splitting the same table at once would otherwise produce
     * two sets of amounts that both look authoritative, and nobody could say
     * which one the customer agreed to.
     */
    uniqueIndex('bill_splits_one_locked_per_session')
      .on(t.sessionId)
      .where(sql`status = 'locked'`),

    index('bill_splits_session_idx').on(t.sessionId),
    index('bill_splits_restaurant_idx').on(t.restaurantId),

    tenantPolicy('bill_splits_tenant_isolation', t.restaurantId),

    /** A diner may see how their own table's bill was divided. */
    pgPolicy('bill_splits_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.sessionId} = ${currentSessionId()}`,
    }),
  ],
)

export const billSplitShares = pgTable(
  'bill_split_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    /** Denormalised so the diner policy needs no subquery. */
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'cascade' }),
    splitId: uuid('split_id')
      .notNull()
      .references(() => billSplits.id, { onDelete: 'cascade' }),

    memberId: uuid('member_id').references(() => diningSessionMembers.id, {
      onDelete: 'set null',
    }),

    /**
     * The name is snapshotted alongside the id. A member row can be removed
     * when a session is tidied up, and a settled share that says "someone"
     * is useless to anyone investigating a discrepancy later.
     */
    displayNameSnapshot: text('display_name_snapshot').notNull(),

    subtotalMinor: integer('subtotal_minor').notNull(),
    discountMinor: integer('discount_minor').notNull(),
    serviceChargeMinor: integer('service_charge_minor').notNull(),
    taxMinor: integer('tax_minor').notNull(),
    totalMinor: integer('total_minor').notNull(),

    /**
     * Which dishes this share was made of, frozen at lock time.
     *
     * JSONB rather than a third table: this breakdown is written once, read
     * whole, and never queried by line. That is the opposite of the menu
     * attributes case in Phase 2, where the values needed validating and
     * filtering and therefore earned real columns.
     */
    lineBreakdown: jsonb('line_breakdown')
      .$type<
        {
          lineId: string
          nameSnapshot: string
          amountMinor: number
          isShared: boolean
        }[]
      >()
      .notNull()
      .default([]),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('bill_split_shares_split_idx').on(t.splitId),
    index('bill_split_shares_session_idx').on(t.sessionId),
    index('bill_split_shares_member_idx').on(t.memberId),
    index('bill_split_shares_restaurant_idx').on(t.restaurantId),

    tenantPolicy('bill_split_shares_tenant_isolation', t.restaurantId),

    /**
     * A diner sees every share on their table, not only their own — knowing
     * what everyone else owes is the point of splitting a bill together.
     * There is no member INSERT policy: only staff create splits.
     */
    pgPolicy('bill_split_shares_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.sessionId} = ${currentSessionId()}`,
    }),
  ],
)

export const billSplitsRelations = relations(billSplits, ({ one, many }) => ({
  session: one(diningSessions, {
    fields: [billSplits.sessionId],
    references: [diningSessions.id],
  }),
  shares: many(billSplitShares),
}))

export const billSplitSharesRelations = relations(
  billSplitShares,
  ({ one }) => ({
    split: one(billSplits, {
      fields: [billSplitShares.splitId],
      references: [billSplits.id],
    }),
    member: one(diningSessionMembers, {
      fields: [billSplitShares.memberId],
      references: [diningSessionMembers.id],
    }),
  }),
)
