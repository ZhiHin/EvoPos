import { relations, sql } from 'drizzle-orm'
import {
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { branches, restaurants } from './tenancy'
import { diningTables } from './structure'
import { customers } from './promotion'
import { diningSessions } from './session'
import { users } from './identity'
import { tenantPolicy, timestamps } from './_shared'

/**
 * Reservations, the waiting list, and the roster.
 *
 * Bookings and shifts are both intervals against a shared resource — a table,
 * a person — so both are stored with an explicit start and end rather than a
 * start and a duration. A duration is a second thing to keep correct when
 * either end moves.
 */

export const reservationStatus = pgEnum('reservation_status', [
  'pending',
  'confirmed',
  'seated',
  'completed',
  'cancelled',
  'no_show',
])

export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    /**
     * Optional. Most bookings are taken over the phone from someone who is
     * not a member, and requiring a customer record first would mean creating
     * one for every enquiry that never turns up.
     */
    customerId: uuid('customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),

    /** Held on the booking regardless, so a cancelled member booking still reads. */
    guestName: text('guest_name').notNull(),
    guestPhone: text('guest_phone'),
    guestEmail: text('guest_email'),

    partySize: smallint('party_size').notNull(),

    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),

    tableId: uuid('table_id').references(() => diningTables.id, {
      onDelete: 'set null',
    }),

    status: reservationStatus('status').notNull().default('pending'),

    notes: text('notes'),
    /** Allergies, a birthday, a wheelchair — what the floor needs to know. */
    occasion: text('occasion'),

    /** Set when seated, linking the booking to the bill it became. */
    sessionId: uuid('session_id').references(() => diningSessions.id, {
      onDelete: 'set null',
    }),
    seatedAt: timestamp('seated_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
  },
  (t) => [
    /**
     * A table cannot hold two live bookings at once. Partial, because a
     * cancelled or completed booking must not block the slot it released —
     * and because the same table is deliberately reusable across the evening.
     */
    index('reservations_table_window_idx').on(t.tableId, t.startsAt),
    index('reservations_branch_window_idx').on(
      t.restaurantId,
      t.branchId,
      t.startsAt,
    ),
    index('reservations_customer_idx').on(t.customerId),
    tenantPolicy('reservations_tenant_isolation', t.restaurantId),
  ],
)

export const waitlistStatus = pgEnum('waitlist_status', [
  'waiting',
  'notified',
  'seated',
  'left',
])

export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    customerId: uuid('customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),

    guestName: text('guest_name').notNull(),
    guestPhone: text('guest_phone'),
    partySize: smallint('party_size').notNull(),

    /**
     * What was quoted, in minutes, at the moment of joining. Kept rather than
     * recomputed so "you said twenty minutes" can be answered honestly an
     * hour later.
     */
    quotedWaitMinutes: integer('quoted_wait_minutes').notNull().default(0),

    status: waitlistStatus('status').notNull().default('waiting'),

    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    seatedAt: timestamp('seated_at', { withTimezone: true }),
    leftAt: timestamp('left_at', { withTimezone: true }),

    sessionId: uuid('session_id').references(() => diningSessions.id, {
      onDelete: 'set null',
    }),

    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    index('waitlist_branch_status_idx').on(t.branchId, t.status, t.joinedAt),
    tenantPolicy('waitlist_entries_tenant_isolation', t.restaurantId),
  ],
)

export const shifts = pgTable(
  'shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),

    /** Free text: "Bar", "Pass", "Front". Not a role — that is RBAC. */
    position: text('position'),
    notes: text('notes'),

    /**
     * Unpublished shifts are a draft nobody has been told about. Publishing
     * is what makes a roster a commitment, and it is deliberately a separate
     * act from saving one.
     */
    publishedAt: timestamp('published_at', { withTimezone: true }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
  },
  (t) => [
    index('shifts_branch_window_idx').on(t.branchId, t.startsAt),
    index('shifts_user_window_idx').on(t.userId, t.startsAt),
    tenantPolicy('shifts_tenant_isolation', t.restaurantId),
  ],
)

/**
 * One row per clock-in.
 *
 * A punch is not a shift. Unrostered work happens — covering a sick
 * colleague, coming in on a day off — so `shiftId` is nullable and a punch
 * with none is a real record rather than an error.
 */
export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    shiftId: uuid('shift_id').references(() => shifts.id, {
      onDelete: 'set null',
    }),

    clockInAt: timestamp('clock_in_at', { withTimezone: true }).notNull(),
    clockOutAt: timestamp('clock_out_at', { withTimezone: true }),

    breakMinutes: integer('break_minutes').notNull().default(0),

    /** Snapshotted against the rostered start at the moment of clocking in. */
    latenessMinutes: integer('lateness_minutes').notNull().default(0),

    /**
     * Set when someone corrects the entry. Its presence is the flag — a
     * separate boolean would be a second fact that can disagree with this one.
     */
    editedByUserId: uuid('edited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    editReason: text('edit_reason'),

    ...timestamps,
  },
  (t) => [
    /**
     * One open punch per person. Without this a double-tap on the clock-in
     * button opens two, and every subsequent clock-out closes an arbitrary
     * one of them.
     */
    uniqueIndex('attendance_open_punch_key')
      .on(t.userId)
      .where(sql`clock_out_at is null`),
    index('attendance_user_window_idx').on(t.userId, t.clockInAt),
    index('attendance_branch_window_idx').on(t.branchId, t.clockInAt),
    tenantPolicy('attendance_records_tenant_isolation', t.restaurantId),
  ],
)

// --- relations ---

export const reservationsRelations = relations(reservations, ({ one }) => ({
  branch: one(branches, {
    fields: [reservations.branchId],
    references: [branches.id],
  }),
  table: one(diningTables, {
    fields: [reservations.tableId],
    references: [diningTables.id],
  }),
  customer: one(customers, {
    fields: [reservations.customerId],
    references: [customers.id],
  }),
  session: one(diningSessions, {
    fields: [reservations.sessionId],
    references: [diningSessions.id],
  }),
}))

export const waitlistEntriesRelations = relations(
  waitlistEntries,
  ({ one }) => ({
    branch: one(branches, {
      fields: [waitlistEntries.branchId],
      references: [branches.id],
    }),
    customer: one(customers, {
      fields: [waitlistEntries.customerId],
      references: [customers.id],
    }),
  }),
)

export const shiftsRelations = relations(shifts, ({ one, many }) => ({
  branch: one(branches, {
    fields: [shifts.branchId],
    references: [branches.id],
  }),
  user: one(users, { fields: [shifts.userId], references: [users.id] }),
  attendance: many(attendanceRecords),
}))

export const attendanceRecordsRelations = relations(
  attendanceRecords,
  ({ one }) => ({
    shift: one(shifts, {
      fields: [attendanceRecords.shiftId],
      references: [shifts.id],
    }),
    user: one(users, {
      fields: [attendanceRecords.userId],
      references: [users.id],
    }),
  }),
)
