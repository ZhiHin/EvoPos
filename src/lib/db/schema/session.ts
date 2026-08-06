import { relations, sql } from 'drizzle-orm'
import {
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { kitchenStations } from './kitchen'
import { menuItems } from './menu'
import { combos, modifierOptions } from './modifiers'
import { diningTables } from './structure'
import { branches, restaurants } from './tenancy'
import { users } from './identity'
import {
  appRole,
  currentMemberToken,
  currentSessionId,
  tenantPolicy,
  timestamps,
} from './_shared'

/**
 * The Dining Session — the core business object.
 *
 * Everything the restaurant does at a table hangs off one of these: who is
 * sitting there, what they ordered, what they owe, what the kitchen is
 * cooking, and eventually how the bill was split.
 */

export const diningSessionStatus = pgEnum('dining_session_status', [
  'open',
  'bill_requested',
  'closed',
  'abandoned',
])

/**
 * Fulfilment type.
 *
 * Takeaway and delivery are sessions without a table, not a parallel order
 * model. One bill model means Smart Bill in Phase 6 splits a delivery order
 * with exactly the same code it splits a dinner table — and the partial
 * unique index keeps working unchanged, because NULL table ids are distinct
 * and unlimited takeaway sessions can coexist.
 *
 * It also means "hold order" needs no state of its own: for dine-in the table
 * is the hold, and for takeaway an open session with no table already IS a
 * parked transaction waiting to be resumed.
 */
export const diningSessionType = pgEnum('dining_session_type', [
  'dine_in',
  'takeaway',
  'delivery',
])

export const sessionDiscountType = pgEnum('session_discount_type', [
  'percentage',
  'fixed',
])

export const diningSessions = pgTable(
  'dining_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    /** Null for takeaway and delivery — there is no table to sit at. */
    tableId: uuid('table_id').references(() => diningTables.id, {
      onDelete: 'restrict',
    }),

    type: diningSessionType('type').notNull().default('dine_in'),
    status: diningSessionStatus('status').notNull().default('open'),

    /**
     * Minimal customer capture for takeaway and delivery. Deliberately plain
     * columns rather than a link to a CRM record — the CRM arrives in Phase
     * 11, and a walk-in giving a name for a paper bag should not require one.
     */
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    deliveryAddress: text('delivery_address'),

    /** Null when a diner opened it by scanning rather than a staff member. */
    openedByUserId: uuid('opened_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    guestCount: integer('guest_count'),
    notes: text('notes'),

    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    /**
     * At most one live session per table, enforced by the database rather
     * than by a check-then-insert in application code.
     *
     * Two diners scanning the same QR within milliseconds of each other is
     * the ordinary case, not an edge case — a read-then-write would let both
     * succeed and split one table across two bills. The partial index makes
     * the second insert fail, and the service turns that into "join the
     * existing session".
     */
    uniqueIndex('dining_sessions_one_open_per_table')
      .on(t.tableId)
      .where(sql`status in ('open', 'bill_requested')`),

    index('dining_sessions_restaurant_status_idx').on(t.restaurantId, t.status),
    index('dining_sessions_branch_idx').on(t.branchId),
    index('dining_sessions_table_idx').on(t.tableId),

    tenantPolicy('dining_sessions_tenant_isolation', t.restaurantId),

    /** A diner sees exactly the session they joined. */
    pgPolicy('dining_sessions_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.id} = ${currentSessionId()}`,
    }),
  ],
)

/**
 * A person at the table.
 *
 * Deliberately not a `user`. Someone scanning a QR to order lunch has no
 * account, wants none, and asking for one is how QR ordering dies. They are
 * identified by a token in a cookie, valid for this session only.
 */
export const diningSessionMembers = pgTable(
  'dining_session_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'cascade' }),

    displayName: text('display_name').notNull(),

    /**
     * HMAC of the token in the diner's cookie, never the token itself — the
     * same rule as staff sessions. This IS the "time-limited" credential the
     * spec asks for; the printed QR token deliberately is not one.
     */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when someone leaves early; their placed orders remain on the bill. */
    leftAt: timestamp('left_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('dining_session_members_token_key').on(t.tokenHash),
    index('dining_session_members_session_idx').on(t.sessionId),
    index('dining_session_members_restaurant_idx').on(t.restaurantId),

    tenantPolicy('dining_session_members_tenant_isolation', t.restaurantId),

    /**
     * Bootstraps a diner's identity from their cookie, exactly as
     * `dining_tables_qr_lookup` does for a scan: presenting one token reveals
     * one member row and nothing else, so the table cannot be enumerated.
     */
    pgPolicy('dining_session_members_token_lookup', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.tokenHash} = ${currentMemberToken()}`,
    }),

    /**
     * Lets a diner see who else is at their table — needed to attribute a
     * shared dish, and for the split screen in Phase 6.
     *
     * Compares only a column of this table against a session variable, so it
     * does not query `dining_session_members` from within its own policy.
     * That would recurse, and Postgres would refuse it.
     */
    pgPolicy('dining_session_members_peers_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.sessionId} = ${currentSessionId()}`,
    }),
  ],
)

export const orderLineStatus = pgEnum('order_line_status', [
  'pending',
  'preparing',
  'ready',
  'served',
  'voided',
])

/**
 * One configured item on a session's bill.
 *
 * Every price-bearing field is a SNAPSHOT taken when the line was placed.
 * `menuItemId` is kept for reporting but is deliberately not what the bill is
 * computed from: a manager editing a price at 19:00 must not silently change
 * what a table seated at 18:30 owes, and `ON DELETE SET NULL` means deleting
 * a menu item cannot erase the history of it having been sold.
 */
export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'cascade' }),

    /**
     * Who ordered it. Null means shared by the whole table — the distinction
     * Smart Bill splitting is built on in Phase 6.
     */
    memberId: uuid('member_id').references(() => diningSessionMembers.id, {
      onDelete: 'set null',
    }),

    menuItemId: uuid('menu_item_id').references(() => menuItems.id, {
      onDelete: 'set null',
    }),
    comboId: uuid('combo_id').references(() => combos.id, {
      onDelete: 'set null',
    }),

    /** Snapshots. What the customer was shown and agreed to pay. */
    nameSnapshot: text('name_snapshot').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
    quantity: integer('quantity').notNull().default(1),
    lineTotalMinor: integer('line_total_minor').notNull(),

    status: orderLineStatus('status').notNull().default('pending'),
    notes: text('notes'),

    /**
     * Which station is making this, resolved and frozen when the order was
     * placed.
     *
     * Snapshotted rather than looked up live: if someone re-routes desserts
     * to a new station mid-service, tickets already on the pastry screen must
     * not silently jump to another one, leaving a half-made dish on a queue
     * nobody is watching.
     */
    kitchenStationId: uuid('kitchen_station_id').references(
      () => kitchenStations.id,
      { onDelete: 'set null' },
    ),

    placedAt: timestamp('placed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when the kitchen starts it, finishes it, and it reaches the table. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    servedAt: timestamp('served_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
  },
  (t) => [
    index('order_lines_session_idx').on(t.sessionId),
    index('order_lines_member_idx').on(t.memberId),
    index('order_lines_restaurant_status_idx').on(t.restaurantId, t.status),

    tenantPolicy('order_lines_tenant_isolation', t.restaurantId),

    pgPolicy('order_lines_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.sessionId} = ${currentSessionId()}`,
    }),

    /**
     * A diner may add to their own session's bill and nothing else. There is
     * deliberately no member UPDATE or DELETE policy: removing an item from a
     * bill is a void, which is staff work and audited.
     */
    pgPolicy('order_lines_member_insert', {
      as: 'permissive',
      for: 'insert',
      to: appRole,
      withCheck: sql`${t.sessionId} = ${currentSessionId()}`,
    }),
  ],
)

/**
 * The modifier choices frozen onto an order line.
 *
 * Names and deltas are snapshotted alongside the option id for the same
 * reason as the line itself — a receipt reprinted next month must still say
 * "Large +1.50", even if "Large" was renamed or repriced since.
 */
export const orderLineModifiers = pgTable(
  'order_line_modifiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    /** Denormalised so the diner policy needs no subquery. */
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'cascade' }),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references(() => orderLines.id, { onDelete: 'cascade' }),

    modifierOptionId: uuid('modifier_option_id').references(
      () => modifierOptions.id,
      { onDelete: 'set null' },
    ),

    groupNameSnapshot: text('group_name_snapshot').notNull(),
    optionNameSnapshot: text('option_name_snapshot').notNull(),
    priceDeltaMinor: integer('price_delta_minor').notNull(),
    quantity: integer('quantity').notNull().default(1),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('order_line_modifiers_line_idx').on(t.orderLineId),
    index('order_line_modifiers_session_idx').on(t.sessionId),
    index('order_line_modifiers_restaurant_idx').on(t.restaurantId),

    tenantPolicy('order_line_modifiers_tenant_isolation', t.restaurantId),

    pgPolicy('order_line_modifiers_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.sessionId} = ${currentSessionId()}`,
    }),

    pgPolicy('order_line_modifiers_member_insert', {
      as: 'permissive',
      for: 'insert',
      to: appRole,
      withCheck: sql`${t.sessionId} = ${currentSessionId()}`,
    }),
  ],
)

export const serviceRequestType = pgEnum('service_request_type', [
  'call_waiter',
  'request_bill',
])

export const serviceRequestStatus = pgEnum('service_request_status', [
  'open',
  'resolved',
])

export const serviceRequests = pgTable(
  'service_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').references(() => diningSessionMembers.id, {
      onDelete: 'set null',
    }),

    type: serviceRequestType('type').notNull(),
    status: serviceRequestStatus('status').notNull().default('open'),
    note: text('note'),

    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('service_requests_session_idx').on(t.sessionId),
    index('service_requests_open_idx')
      .on(t.restaurantId, t.status)
      .where(sql`status = 'open'`),

    tenantPolicy('service_requests_tenant_isolation', t.restaurantId),

    pgPolicy('service_requests_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.sessionId} = ${currentSessionId()}`,
    }),

    pgPolicy('service_requests_member_insert', {
      as: 'permissive',
      for: 'insert',
      to: appRole,
      withCheck: sql`${t.sessionId} = ${currentSessionId()}`,
    }),
  ],
)

/**
 * Manual, staff-applied discounts.
 *
 * Distinct from the Phase 9 promotion engine: that decides discounts from
 * rules, this records a human deciding something costs less. Rows are never
 * deleted — a removed discount keeps its row with `removedAt` set, because
 * "who comped this, and who took it back off" is the first question asked
 * when the till does not balance.
 */
export const sessionDiscounts = pgTable(
  'session_discounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diningSessions.id, { onDelete: 'cascade' }),

    type: sessionDiscountType('type').notNull(),
    /** Basis points when percentage, minor units when fixed. */
    value: integer('value').notNull(),
    reason: text('reason').notNull(),

    appliedByUserId: uuid('applied_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedByUserId: uuid('removed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('session_discounts_session_idx').on(t.sessionId),
    index('session_discounts_restaurant_idx').on(t.restaurantId),

    tenantPolicy('session_discounts_tenant_isolation', t.restaurantId),

    /**
     * A diner may see a discount on their own bill but never create one.
     * There is no member INSERT policy here, deliberately.
     */
    pgPolicy('session_discounts_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.sessionId} = ${currentSessionId()}`,
    }),
  ],
)

export const diningSessionsRelations = relations(
  diningSessions,
  ({ one, many }) => ({
    table: one(diningTables, {
      fields: [diningSessions.tableId],
      references: [diningTables.id],
    }),
    members: many(diningSessionMembers),
    orderLines: many(orderLines),
    serviceRequests: many(serviceRequests),
  }),
)

export const diningSessionMembersRelations = relations(
  diningSessionMembers,
  ({ one, many }) => ({
    session: one(diningSessions, {
      fields: [diningSessionMembers.sessionId],
      references: [diningSessions.id],
    }),
    orderLines: many(orderLines),
  }),
)

export const orderLinesRelations = relations(orderLines, ({ one, many }) => ({
  session: one(diningSessions, {
    fields: [orderLines.sessionId],
    references: [diningSessions.id],
  }),
  member: one(diningSessionMembers, {
    fields: [orderLines.memberId],
    references: [diningSessionMembers.id],
  }),
  modifiers: many(orderLineModifiers),
}))

export const orderLineModifiersRelations = relations(
  orderLineModifiers,
  ({ one }) => ({
    orderLine: one(orderLines, {
      fields: [orderLineModifiers.orderLineId],
      references: [orderLines.id],
    }),
  }),
)
