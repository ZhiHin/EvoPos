import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { customers } from './promotion'
import { diningSessions, diningSessionType } from './session'
import { branches, restaurants } from './tenancy'
import { users } from './identity'
import { tenantPolicy, timestamps } from './_shared'

/**
 * The financial record of a settled bill.
 *
 * Written once, when the bill is settled, and never updated. This is the
 * single most important decision in Phase 12, so it is worth stating plainly
 * why the alternative fails.
 *
 * Every figure on a bill — service charge, tax, the total — is computed by
 * `calculateBill` from the restaurant's *current* settings. Recomputing a
 * report from order lines would therefore apply today's tax rate to last
 * quarter's trade. Raise SST from 6% to 8% and a report filed in March
 * quietly reports different numbers in April, with nothing in the system
 * having changed and nobody able to say which version was submitted.
 *
 * A snapshot makes a closed period closed. The rates that produced these
 * figures are stored alongside them, so a return can be defended years later
 * with the arithmetic that actually produced it.
 *
 * Refunds are deliberately NOT stored here. They happen after settlement and
 * have their own rows with their own timestamps; folding them in would mean
 * updating a record whose entire value is that it never changes.
 */
export const salesRecords = pgTable(
  'sales_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    /**
     * `ON DELETE restrict`, matching payments. A bill with a financial record
     * behind it is not something that may quietly disappear.
     */
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'restrict' }),

    type: diningSessionType('type').notNull(),

    /** Null when nobody was counted, which is different from a table of zero. */
    covers: integer('covers'),

    // --- the bill, exactly as the customer was charged ---
    subtotalMinor: integer('subtotal_minor').notNull(),
    discountMinor: integer('discount_minor').notNull(),
    serviceChargeMinor: integer('service_charge_minor').notNull(),
    taxMinor: integer('tax_minor').notNull(),
    totalMinor: integer('total_minor').notNull(),

    /** What was actually collected, for reconciling against takings. */
    paidMinor: integer('paid_minor').notNull(),

    /**
     * The rates in force at the moment of settlement.
     *
     * Stored so the arithmetic can be re-derived rather than trusted. Without
     * them the snapshot is a set of numbers with no way to check them.
     */
    taxRateBasisPoints: integer('tax_rate_basis_points').notNull(),
    serviceChargeBasisPoints: integer('service_charge_basis_points').notNull(),
    taxIsIncluded: boolean('tax_is_included').notNull(),

    /**
     * Cost of what this bill consumed, from the stock ledger — not from
     * today's ingredient costs, which move with every delivery.
     */
    costMinor: integer('cost_minor').notNull().default(0),

    /**
     * The part of the subtotal made up of items that actually consumed
     * something.
     *
     * Without it, margin silently means "margin on the dishes somebody got
     * round to writing a recipe for", and a menu that is a fifth costed
     * reports a 95% margin to an owner who believes it.
     */
    costedSubtotalMinor: integer('costed_subtotal_minor').notNull().default(0),

    customerId: uuid('customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),
    settledByUserId: uuid('settled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    settledAt: timestamp('settled_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    /**
     * One record per bill. Settlement is idempotent at the payment layer, but
     * a retried close must not produce a second row — which would double a
     * day's reported revenue while every underlying payment stayed correct,
     * and that discrepancy is very hard to find from the total alone.
     */
    uniqueIndex('sales_records_session_key').on(t.sessionId),

    /** The index every report reads through: this tenant, this period. */
    index('sales_records_restaurant_settled_idx').on(
      t.restaurantId,
      t.settledAt,
    ),
    index('sales_records_branch_settled_idx').on(t.branchId, t.settledAt),
    index('sales_records_customer_idx').on(t.customerId),

    tenantPolicy('sales_records_tenant_isolation', t.restaurantId),
  ],
)

export const salesRecordsRelations = relations(salesRecords, ({ one }) => ({
  session: one(diningSessions, {
    fields: [salesRecords.sessionId],
    references: [diningSessions.id],
  }),
  branch: one(branches, {
    fields: [salesRecords.branchId],
    references: [branches.id],
  }),
  customer: one(customers, {
    fields: [salesRecords.customerId],
    references: [customers.id],
  }),
}))
