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

import { billSplitShares } from './bill'
import { diningSessions } from './session'
import { restaurants } from './tenancy'
import { users } from './identity'
import {
  appRole,
  currentSessionId,
  tenantPolicy,
  timestamps,
} from './_shared'

/**
 * Payments.
 *
 * The table where money becomes real, so its rules are stricter than
 * anywhere else in the system: nothing is ever deleted, every amount is an
 * integer, and a payment is only `succeeded` when something outside this
 * application has confirmed it.
 */

export const paymentMethod = pgEnum('payment_method', [
  'cash',
  /** A physical terminal that has already printed an approval slip. */
  'card_terminal',
  'ewallet_terminal',
  'bank_transfer',
  /** Online gateway. Only ever `succeeded` via a verified webhook. */
  'gateway',
  'other',
])

export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'succeeded',
  'failed',
  'voided',
])

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'restrict' }),

    /**
     * Set when settling one person's share of a split rather than the whole
     * bill. `ON DELETE SET NULL` because voiding a split must never orphan
     * or destroy a record of money that changed hands.
     */
    splitShareId: uuid('split_share_id').references(() => billSplitShares.id, {
      onDelete: 'set null',
    }),

    method: paymentMethod('method').notNull(),
    status: paymentStatus('status').notNull(),

    /** What the customer is charged, after any cash rounding. */
    amountMinor: integer('amount_minor').notNull(),

    /** Cash only: what was handed over, and what went back. */
    tenderedMinor: integer('tendered_minor'),
    changeMinor: integer('change_minor'),
    /** The 5-sen adjustment, kept so a receipt can show it as its own line. */
    roundingAdjustmentMinor: integer('rounding_adjustment_minor')
      .notNull()
      .default(0),

    /**
     * Supplied by the client and unique per restaurant.
     *
     * This is what stops a double-clicked "Take payment" button charging
     * twice. Retrofitting idempotency after the first duplicate-charge
     * complaint is painful and slow, so it is here from the first payment
     * this system ever records.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    /** Terminal approval code, transfer reference, etc. Free text. */
    reference: text('reference'),

    /**
     * Reserved for the online gateway integration. Present now so adding a
     * provider is a service change rather than a migration during a phase
     * where money is already flowing.
     */
    gatewayProvider: text('gateway_provider'),
    gatewayPaymentId: text('gateway_payment_id'),
    gatewayPayload: jsonb('gateway_payload'),

    takenByUserId: uuid('taken_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    takenAt: timestamp('taken_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    voidReason: text('void_reason'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('payments_idempotency_key').on(t.restaurantId, t.idempotencyKey),
    index('payments_session_idx').on(t.sessionId),
    index('payments_share_idx').on(t.splitShareId),
    index('payments_restaurant_taken_idx').on(t.restaurantId, t.takenAt),
    index('payments_gateway_idx').on(t.gatewayProvider, t.gatewayPaymentId),

    tenantPolicy('payments_tenant_isolation', t.restaurantId),

    /**
     * A diner may see what has been paid on their own table — "has my share
     * gone through" is a reasonable question to ask a phone rather than a
     * waiter. There is deliberately no member INSERT policy: a diner cannot
     * record a payment, because saying you paid is not paying.
     */
    pgPolicy('payments_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.sessionId} = ${currentSessionId()}`,
    }),
  ],
)

/**
 * Refunds, as their own rows rather than negative payments.
 *
 * A refund carries a reason and an approver, and answers a different question
 * during an investigation than a sale does. Folding them into `payments` as
 * negatives would make every takings query remember to filter by sign, and
 * one that forgot would silently under-report.
 */
export const paymentRefunds = pgTable(
  'payment_refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    /** Denormalised so the diner policy needs no subquery. */
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),

    amountMinor: integer('amount_minor').notNull(),
    reason: text('reason').notNull(),

    idempotencyKey: text('idempotency_key').notNull(),

    issuedByUserId: uuid('issued_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('payment_refunds_idempotency_key').on(
      t.restaurantId,
      t.idempotencyKey,
    ),
    index('payment_refunds_payment_idx').on(t.paymentId),
    index('payment_refunds_session_idx').on(t.sessionId),
    index('payment_refunds_restaurant_created_idx').on(
      t.restaurantId,
      t.createdAt,
    ),

    tenantPolicy('payment_refunds_tenant_isolation', t.restaurantId),

    pgPolicy('payment_refunds_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.sessionId} = ${currentSessionId()}`,
    }),
  ],
)

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  session: one(diningSessions, {
    fields: [payments.sessionId],
    references: [diningSessions.id],
  }),
  share: one(billSplitShares, {
    fields: [payments.splitShareId],
    references: [billSplitShares.id],
  }),
  refunds: many(paymentRefunds),
}))

export const paymentRefundsRelations = relations(
  paymentRefunds,
  ({ one }) => ({
    payment: one(payments, {
      fields: [paymentRefunds.paymentId],
      references: [payments.id],
    }),
  }),
)
