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

import { branches, restaurants } from './tenancy'
import {
  appRole,
  currentQrToken,
  tenantPolicy,
  timestamps,
} from './_shared'

/**
 * Physical structure within a branch.
 *
 *   restaurant -> branch -> floor -> table
 *
 * `restaurantId` is carried on every table here even though it is derivable
 * from `branchId`. An RLS policy can only reference columns on its own table,
 * so without it each row would need a subquery to be tenant-filtered.
 */
export const floors = pgTable(
  'floors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** Ascending. Ties broken by name. */
    displayOrder: integer('display_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('floors_branch_name_key').on(t.branchId, t.name),
    index('floors_branch_id_idx').on(t.branchId),
    index('floors_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('floors_tenant_isolation', t.restaurantId),
  ],
)

export const floorsRelations = relations(floors, ({ one }) => ({
  branch: one(branches, {
    fields: [floors.branchId],
    references: [branches.id],
  }),
}))

export const tableStatus = pgEnum('table_status', [
  'available',
  'occupied',
  'reserved',
  'out_of_service',
])

export const diningTables = pgTable(
  'dining_tables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    /**
     * Deleting a floor unassigns its tables rather than destroying them — a
     * floor is a grouping label, and losing the label should not lose the
     * furniture.
     */
    floorId: uuid('floor_id').references(() => floors.id, {
      onDelete: 'set null',
    }),

    /** Short human identifier printed on the table, e.g. "T12". */
    code: text('code').notNull(),
    name: text('name'),
    capacity: integer('capacity').notNull().default(2),
    status: tableStatus('status').notNull().default('available'),

    /**
     * The value encoded in the printed QR.
     *
     * Stored in plaintext, unlike session tokens which are HMAC'd. A
     * restaurant must be able to reprint a damaged sticker without
     * invalidating the table, and a one-way hash makes that impossible.
     *
     * Safe because this token confers no authority. It names a table; it
     * authenticates nobody. Ordering requires a dining-session token
     * (Phase 4), which is short-lived and issued only on a successful join.
     * That split is also how the spec's "time-limited" requirement is met
     * without asking anyone to reprint stickers nightly.
     */
    qrToken: text('qr_token').notNull(),
    qrRotatedAt: timestamp('qr_rotated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Floor-plan coordinates. Null until someone arranges the layout. */
    positionX: integer('position_x'),
    positionY: integer('position_y'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('dining_tables_qr_token_key').on(t.qrToken),
    uniqueIndex('dining_tables_branch_code_key').on(t.branchId, t.code),
    index('dining_tables_branch_id_idx').on(t.branchId),
    index('dining_tables_floor_id_idx').on(t.floorId),
    index('dining_tables_restaurant_id_idx').on(t.restaurantId),

    tenantPolicy('dining_tables_tenant_isolation', t.restaurantId),

    /**
     * Public scan lookup — what makes an unauthenticated QR endpoint safe.
     *
     * The policy reveals exactly the row whose token matches the session
     * variable. A caller holding one token sees one table; a caller holding
     * none sees nothing. Enumeration is impossible at the database level
     * rather than merely prevented by careful application code.
     *
     * SELECT only: scanning a QR never writes.
     */
    pgPolicy('dining_tables_qr_lookup', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.qrToken} = ${currentQrToken()}`,
    }),
  ],
)

export const diningTablesRelations = relations(diningTables, ({ one }) => ({
  branch: one(branches, {
    fields: [diningTables.branchId],
    references: [branches.id],
  }),
  floor: one(floors, {
    fields: [diningTables.floorId],
    references: [floors.id],
  }),
}))
