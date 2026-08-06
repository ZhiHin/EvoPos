import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { menuItems } from './menu'
import { branches, restaurants } from './tenancy'
import { tenantPolicy, timestamps } from './_shared'

/**
 * The Universal Modifier Engine and Combo Builder.
 *
 * Both are pure configuration: "Size", "Ice level", "Choose your main" are
 * rows, never code. A hotpot chain and a bubble tea shop use the same tables
 * and differ only in what they put in them.
 */

export const modifierGroupStatus = pgEnum('modifier_group_status', [
  'active',
  'hidden',
])

/**
 * A reusable question asked about an item: "What size?", "How much ice?"
 *
 * Groups belong to the restaurant, not to an item, and attach to items
 * through `menu_item_modifier_groups`. One "Size" group shared across forty
 * drinks is the difference between changing a price once and changing it
 * forty times.
 */
export const modifierGroups = pgTable(
  'modifier_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),

    /**
     * Selection rules. `required` is derived, not stored: a group is required
     * exactly when minSelection >= 1. Storing both invites the two to
     * disagree, and then no one knows which is the truth.
     */
    minSelection: integer('min_selection').notNull().default(0),
    /** Null means unlimited. */
    maxSelection: integer('max_selection'),

    displayOrder: integer('display_order').notNull().default(0),
    status: modifierGroupStatus('status').notNull().default('active'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('modifier_groups_restaurant_name_key').on(
      t.restaurantId,
      t.name,
    ),
    index('modifier_groups_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('modifier_groups_tenant_isolation', t.restaurantId),
  ],
)

export const modifierOptions = pgTable(
  'modifier_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => modifierGroups.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /**
     * Signed, in minor units. Negative is legitimate and used: "small" often
     * costs less than the listed price, and a discount expressed as a
     * negative delta keeps one arithmetic path instead of two.
     */
    priceDeltaMinor: integer('price_delta_minor').notNull().default(0),

    isDefault: boolean('is_default').notNull().default(false),

    /**
     * How many times this one option may be taken — "extra shot ×3". 1 is the
     * ordinary case; higher values allow repeats.
     */
    maxQuantity: integer('max_quantity').notNull().default(1),

    displayOrder: integer('display_order').notNull().default(0),
    isAvailable: boolean('is_available').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('modifier_options_group_name_key').on(t.groupId, t.name),
    index('modifier_options_group_id_idx').on(t.groupId),
    index('modifier_options_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('modifier_options_tenant_isolation', t.restaurantId),
  ],
)

/**
 * Attaches a group to an item, with optional per-item rule overrides.
 *
 * The overrides exist because the same group genuinely means different things
 * on different items: "Sauce" might be optional on a burger and mandatory on
 * a plain rice dish. Without them the only way to express that is a second
 * near-identical group, which is what reusable groups were meant to avoid.
 */
export const menuItemModifierGroups = pgTable(
  'menu_item_modifier_groups',
  {
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    modifierGroupId: uuid('modifier_group_id')
      .notNull()
      .references(() => modifierGroups.id, { onDelete: 'cascade' }),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    /** Null means "use the group's own rule". */
    minSelectionOverride: integer('min_selection_override'),
    maxSelectionOverride: integer('max_selection_override'),

    displayOrder: integer('display_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.menuItemId, t.modifierGroupId] }),
    index('menu_item_modifier_groups_group_idx').on(t.modifierGroupId),
    index('menu_item_modifier_groups_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('menu_item_modifier_groups_tenant_isolation', t.restaurantId),
  ],
)

/**
 * Per-branch modifier availability. Exceptions only, as with menu items —
 * absence of a row means available, so a new branch inherits everything
 * rather than opening with nothing.
 */
export const modifierOptionBranches = pgTable(
  'modifier_option_branches',
  {
    modifierOptionId: uuid('modifier_option_id')
      .notNull()
      .references(() => modifierOptions.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    isAvailable: boolean('is_available').notNull().default(false),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.modifierOptionId, t.branchId] }),
    index('modifier_option_branches_branch_idx').on(t.branchId),
    index('modifier_option_branches_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('modifier_option_branches_tenant_isolation', t.restaurantId),
  ],
)

export const comboStatus = pgEnum('combo_status', [
  'active',
  'hidden',
  'archived',
])

/**
 * A combo: set meal, family set, build-your-own, buffet package.
 *
 * All four are the same structure — a base price plus a set of slots, each
 * offering a choice. A "buffet package" is a combo whose slots happen to be
 * empty; "build your own" is one whose slots are wide. There is no
 * combo *type* column, because the type is an emergent property of the rules
 * rather than a thing that changes behaviour.
 */
export const combos = pgTable(
  'combos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),
    imageUrl: text('image_url'),

    /**
     * The combo's own price in minor units. The line total is this plus the
     * deltas of whatever was chosen, so a fixed-price buffet is simply a
     * combo whose every delta is zero.
     */
    basePriceMinor: integer('base_price_minor').notNull(),

    status: comboStatus('status').notNull().default('active'),
    isFeatured: boolean('is_featured').notNull().default(false),
    displayOrder: integer('display_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('combos_restaurant_name_key').on(t.restaurantId, t.name),
    index('combos_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('combos_tenant_isolation', t.restaurantId),
  ],
)

/** A slot within a combo: "Choose your main", "Pick two sides". */
export const comboGroups = pgTable(
  'combo_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    comboId: uuid('combo_id')
      .notNull()
      .references(() => combos.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    minSelection: integer('min_selection').notNull().default(1),
    maxSelection: integer('max_selection'),
    displayOrder: integer('display_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('combo_groups_combo_name_key').on(t.comboId, t.name),
    index('combo_groups_combo_id_idx').on(t.comboId),
    index('combo_groups_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('combo_groups_tenant_isolation', t.restaurantId),
  ],
)

/**
 * A menu item offered inside a combo slot.
 *
 * This is where "nested modifiers inside combo items" comes from, and it
 * needs no table of its own: the slot points at a `menu_item`, and that item
 * already carries its own modifier groups. Picking "Nasi Lemak" inside a set
 * meal inherits its spice-level question automatically. Modelling combo
 * modifiers separately would create a second source of truth for the same
 * question and guarantee the two drift.
 */
export const comboGroupItems = pgTable(
  'combo_group_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    comboGroupId: uuid('combo_group_id')
      .notNull()
      .references(() => comboGroups.id, { onDelete: 'cascade' }),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),

    /** Upgrade cost, or a negative discount, relative to the combo base. */
    priceDeltaMinor: integer('price_delta_minor').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    displayOrder: integer('display_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('combo_group_items_group_item_key').on(
      t.comboGroupId,
      t.menuItemId,
    ),
    index('combo_group_items_group_idx').on(t.comboGroupId),
    index('combo_group_items_menu_item_idx').on(t.menuItemId),
    index('combo_group_items_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('combo_group_items_tenant_isolation', t.restaurantId),
  ],
)

export const modifierGroupsRelations = relations(
  modifierGroups,
  ({ many }) => ({
    options: many(modifierOptions),
    items: many(menuItemModifierGroups),
  }),
)

export const modifierOptionsRelations = relations(
  modifierOptions,
  ({ one, many }) => ({
    group: one(modifierGroups, {
      fields: [modifierOptions.groupId],
      references: [modifierGroups.id],
    }),
    branches: many(modifierOptionBranches),
  }),
)

export const combosRelations = relations(combos, ({ many }) => ({
  groups: many(comboGroups),
}))

export const comboGroupsRelations = relations(
  comboGroups,
  ({ one, many }) => ({
    combo: one(combos, {
      fields: [comboGroups.comboId],
      references: [combos.id],
    }),
    items: many(comboGroupItems),
  }),
)

export const comboGroupItemsRelations = relations(
  comboGroupItems,
  ({ one }) => ({
    group: one(comboGroups, {
      fields: [comboGroupItems.comboGroupId],
      references: [comboGroups.id],
    }),
    menuItem: one(menuItems, {
      fields: [comboGroupItems.menuItemId],
      references: [menuItems.id],
    }),
  }),
)
