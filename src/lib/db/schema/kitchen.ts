import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { branches, restaurants } from './tenancy'
import { dinerMenuReadPolicy, tenantPolicy, timestamps } from './_shared'

/**
 * Kitchen stations, printers and receipt templates.
 *
 * A station is where food is made — the hot line, the bar, the pastry
 * section. A printer is a physical device. They are separate concepts because
 * a station may have no printer (a screen instead) and a printer may serve
 * several stations, and conflating them makes both harder to reconfigure.
 */

export const kitchenStationKind = pgEnum('kitchen_station_kind', [
  'food',
  'beverage',
  'dessert',
  'other',
])

export const kitchenStations = pgTable(
  'kitchen_stations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    kind: kitchenStationKind('kind').notNull().default('food'),
    displayOrder: integer('display_order').notNull().default(0),

    /**
     * Where anything with no explicit routing goes.
     *
     * Not enforced as unique-per-branch by the database, because during
     * reconfiguration a moment with two defaults is survivable while a moment
     * with none is not — an unrouted dish would vanish from every screen.
     * The service picks the lowest display order if several are marked.
     */
    isDefault: boolean('is_default').notNull().default(false),

    isActive: boolean('is_active').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('kitchen_stations_branch_name_key').on(t.branchId, t.name),
    index('kitchen_stations_branch_idx').on(t.branchId),
    index('kitchen_stations_restaurant_idx').on(t.restaurantId),
    tenantPolicy('kitchen_stations_tenant_isolation', t.restaurantId),
  ],
)

export const printerKind = pgEnum('printer_kind', [
  'kitchen',
  'receipt',
  'label',
])

/**
 * A physical printer.
 *
 * This models where a ticket should go and what it should contain. It does
 * NOT send bytes to hardware — that needs an on-site agent talking to a
 * device over USB or the local network, which is a driver rather than
 * anything a web application can do. `connection` is free text describing how
 * that agent should reach it.
 */
export const printers = pgTable(
  'printers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    kind: printerKind('kind').notNull(),

    /** Null for a receipt printer, which is not tied to one station. */
    stationId: uuid('station_id').references(() => kitchenStations.id, {
      onDelete: 'set null',
    }),

    /** e.g. "tcp://192.168.1.50:9100" or "usb:EPSON-TM-T82". */
    connection: text('connection'),
    /** Characters per line. 32 and 42 are the common thermal widths. */
    charactersPerLine: integer('characters_per_line').notNull().default(42),

    isActive: boolean('is_active').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('printers_branch_name_key').on(t.branchId, t.name),
    index('printers_branch_idx').on(t.branchId),
    index('printers_station_idx').on(t.stationId),
    tenantPolicy('printers_tenant_isolation', t.restaurantId),
  ],
)

/**
 * Receipt layout.
 *
 * Everything a restaurant wants on a receipt that the system cannot infer:
 * the trading name, a tax registration line, a thank-you, social handles.
 * The numbers come from the bill; this is the wrapping around them.
 */
export const receiptTemplates = pgTable(
  'receipt_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),

    /** Printed above the items. Trading name, address, phone. */
    headerLines: jsonb('header_lines').$type<string[]>().notNull().default([]),
    /** Printed below the totals. Thanks, socials, return policy. */
    footerLines: jsonb('footer_lines').$type<string[]>().notNull().default([]),

    showTaxNumber: boolean('show_tax_number').notNull().default(true),
    showQrCode: boolean('show_qr_code').notNull().default(false),
    /** Free text under the QR, e.g. "Scan to leave a review". */
    qrCaption: text('qr_caption'),

    charactersPerLine: integer('characters_per_line').notNull().default(42),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('receipt_templates_restaurant_name_key').on(
      t.restaurantId,
      t.name,
    ),
    index('receipt_templates_restaurant_idx').on(t.restaurantId),
    tenantPolicy('receipt_templates_tenant_isolation', t.restaurantId),
    /**
     * A diner viewing their own receipt on their phone needs the same
     * wrapping the printed copy has, or the two disagree.
     */
    dinerMenuReadPolicy('receipt_templates_diner_read', t.restaurantId),
  ],
)

export const kitchenStationsRelations = relations(
  kitchenStations,
  ({ one, many }) => ({
    branch: one(branches, {
      fields: [kitchenStations.branchId],
      references: [branches.id],
    }),
    printers: many(printers),
  }),
)

export const printersRelations = relations(printers, ({ one }) => ({
  station: one(kitchenStations, {
    fields: [printers.stationId],
    references: [kitchenStations.id],
  }),
}))
