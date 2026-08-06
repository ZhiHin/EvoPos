import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

import { branches, restaurants } from './tenancy'
import { tenantPolicy, timestamps } from './_shared'

/**
 * The Universal Menu Engine.
 *
 * Nothing here is restaurant-type specific. A bubble tea shop, a hotpot
 * chain and a fine-dining kitchen differ in the *data* they put into these
 * tables, never in the tables themselves — which is what "configuration
 * instead of customisation" has to mean if it is to survive contact with the
 * second customer.
 */

export const menuCategoryStatus = pgEnum('menu_category_status', [
  'active',
  'hidden',
])

/**
 * Nested categories as an adjacency list.
 *
 * A closure table would be the right structure for deep arbitrary
 * hierarchies. Menu trees are not that — "Food › Mains › Curries" is a deep
 * one — so the extra table, its triggers and its write amplification would be
 * cost with no matching benefit. Depth is capped and cycles are rejected in
 * the service, which is where a recursive CTE can express the check.
 *
 * `onDelete: 'set null'` promotes orphans to the root rather than cascading.
 * Deleting "Drinks" should not silently delete every drink on the menu.
 */
export const menuCategories = pgTable(
  'menu_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    parentId: uuid('parent_id').references(
      (): AnyPgColumn => menuCategories.id,
      { onDelete: 'set null' },
    ),

    name: text('name').notNull(),
    description: text('description'),
    imageUrl: text('image_url'),
    displayOrder: integer('display_order').notNull().default(0),
    status: menuCategoryStatus('status').notNull().default('active'),

    ...timestamps,
  },
  (t) => [
    /**
     * `nullsNotDistinct` matters here. Root categories have a NULL parent,
     * and Postgres treats NULLs as distinct by default — so without it a
     * restaurant could create two root categories both called "Drinks" and
     * the constraint would happily allow it.
     *
     * A UNIQUE *constraint* rather than a unique index, because that is where
     * drizzle exposes `nullsNotDistinct`.
     */
    unique('menu_categories_parent_name_key')
      .on(t.restaurantId, t.parentId, t.name)
      .nullsNotDistinct(),
    index('menu_categories_restaurant_id_idx').on(t.restaurantId),
    index('menu_categories_parent_id_idx').on(t.parentId),
    tenantPolicy('menu_categories_tenant_isolation', t.restaurantId),
  ],
)

/**
 * Tags, allergens and dietary labels share one table.
 *
 * They are the same shape — a named label attached to items — and separating
 * them would mean three near-identical tables, three admin screens and three
 * join tables. `kind` keeps them queryable apart where it matters: allergens
 * are safety information and will need distinct display treatment, but that
 * is a rendering concern, not a storage one.
 */
export const menuTagKind = pgEnum('menu_tag_kind', [
  'label',
  'allergen',
  'dietary',
])

export const menuTags = pgTable(
  'menu_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    kind: menuTagKind('kind').notNull().default('label'),
    name: text('name').notNull(),
    /** Hex colour for the badge, e.g. "#ef4444". Optional. */
    color: text('color'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('menu_tags_restaurant_kind_name_key').on(
      t.restaurantId,
      t.kind,
      t.name,
    ),
    index('menu_tags_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('menu_tags_tenant_isolation', t.restaurantId),
  ],
)

export const menuAttributeType = pgEnum('menu_attribute_type', [
  'text',
  'number',
  'boolean',
  'select',
  'multiselect',
])

/**
 * Owner-defined custom fields — the "unlimited custom attributes" requirement.
 *
 * Definitions live in a table; values live in a JSONB column on the item.
 *
 * Bare JSONB alone would satisfy "unlimited" but nothing else: there would be
 * no way to render an admin form, no way to validate a value, and no way to
 * tell a typo'd key from a new one. Full EAV would give definitions but turn
 * every item read into a pile of joins for data that is always fetched
 * together with its item.
 *
 * The split keeps the schema owner-configurable AND the reads single-row.
 */
export const menuAttributeDefinitions = pgTable(
  'menu_attribute_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    /** Stable key used inside `menu_items.attributes`, e.g. "spice_level". */
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: menuAttributeType('type').notNull(),

    /** Allowed values for select / multiselect. Null for other types. */
    options: jsonb('options').$type<string[] | null>(),

    required: boolean('required').notNull().default(false),
    displayOrder: integer('display_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('menu_attribute_definitions_key_key').on(
      t.restaurantId,
      t.key,
    ),
    index('menu_attribute_definitions_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('menu_attribute_definitions_tenant_isolation', t.restaurantId),
  ],
)

export const menuItemStatus = pgEnum('menu_item_status', [
  'active',
  'hidden',
  'archived',
])

export const menuItems = pgTable(
  'menu_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    /** Nullable so deleting a category leaves its items uncategorised. */
    categoryId: uuid('category_id').references(() => menuCategories.id, {
      onDelete: 'set null',
    }),

    name: text('name').notNull(),
    description: text('description'),
    imageUrl: text('image_url'),

    /**
     * Money in integer minor units against `restaurants.currency`. Never a
     * float — see docs/phase-1/README.md.
     */
    priceMinor: integer('price_minor').notNull(),
    costPriceMinor: integer('cost_price_minor'),

    /**
     * Null means inherit the restaurant-level rate set in Phase 1. An
     * explicit 0 is different from null and means genuinely zero-rated, which
     * is why these are nullable rather than defaulting to 0.
     */
    taxRateBasisPoints: integer('tax_rate_basis_points'),
    serviceChargeBasisPoints: integer('service_charge_basis_points'),

    sku: text('sku'),
    barcode: text('barcode'),

    calories: integer('calories'),
    prepTimeMinutes: integer('prep_time_minutes'),
    /** Free text until Phase 10 links real recipes and stock deduction. */
    ingredientsText: text('ingredients_text'),

    status: menuItemStatus('status').notNull().default('active'),
    isFeatured: boolean('is_featured').notNull().default(false),
    isRecommended: boolean('is_recommended').notNull().default(false),
    displayOrder: integer('display_order').notNull().default(0),

    /** Values for `menu_attribute_definitions`, validated on write. */
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    ...timestamps,
  },
  (t) => [
    /**
     * NULLs stay distinct here, deliberately — most items have no SKU, and
     * they must not collide with each other.
     */
    uniqueIndex('menu_items_restaurant_sku_key').on(t.restaurantId, t.sku),
    uniqueIndex('menu_items_restaurant_barcode_key').on(
      t.restaurantId,
      t.barcode,
    ),
    index('menu_items_restaurant_id_idx').on(t.restaurantId),
    index('menu_items_category_id_idx').on(t.categoryId),
    index('menu_items_status_idx').on(t.restaurantId, t.status),
    /** GIN so custom attributes stay filterable despite living in JSONB. */
    index('menu_items_attributes_idx').using('gin', t.attributes),
    tenantPolicy('menu_items_tenant_isolation', t.restaurantId),
  ],
)

export const menuItemTags = pgTable(
  'menu_item_tags',
  {
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => menuTags.id, { onDelete: 'cascade' }),
    /** Denormalised so the policy needs no subquery. */
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.menuItemId, t.tagId] }),
    index('menu_item_tags_tag_id_idx').on(t.tagId),
    index('menu_item_tags_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('menu_item_tags_tenant_isolation', t.restaurantId),
  ],
)

/**
 * Per-branch availability.
 *
 * Absence of a row means available, so a single-branch restaurant writes
 * nothing and a chain only records exceptions. Modelling it the other way
 * round — a row per item per branch meaning "available" — would mean a
 * hundred-item menu across ten branches carries a thousand rows that all say
 * yes, and a new branch would silently start with an empty menu.
 */
export const menuItemBranches = pgTable(
  'menu_item_branches',
  {
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    isAvailable: boolean('is_available').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.menuItemId, t.branchId] }),
    index('menu_item_branches_branch_id_idx').on(t.branchId),
    index('menu_item_branches_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('menu_item_branches_tenant_isolation', t.restaurantId),
  ],
)

/**
 * Availability windows — breakfast menus, happy hour, weekend-only specials.
 *
 * A row per weekday per window rather than a JSONB blob, because "what is on
 * the menu right now" is a query the POS runs constantly and it must be
 * answerable in SQL rather than by loading every item and filtering in
 * JavaScript.
 *
 * No rows for an item means always available.
 */
export const menuItemAvailability = pgTable(
  'menu_item_availability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    /** 0 = Sunday, matching JavaScript's getDay(). */
    dayOfWeek: smallint('day_of_week').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('menu_item_availability_item_idx').on(t.menuItemId, t.dayOfWeek),
    index('menu_item_availability_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('menu_item_availability_tenant_isolation', t.restaurantId),
  ],
)

export const menuCategoriesRelations = relations(
  menuCategories,
  ({ one, many }) => ({
    parent: one(menuCategories, {
      fields: [menuCategories.parentId],
      references: [menuCategories.id],
      relationName: 'category_parent',
    }),
    children: many(menuCategories, { relationName: 'category_parent' }),
    items: many(menuItems),
  }),
)

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  category: one(menuCategories, {
    fields: [menuItems.categoryId],
    references: [menuCategories.id],
  }),
  tags: many(menuItemTags),
  branches: many(menuItemBranches),
  availability: many(menuItemAvailability),
}))

export const menuItemTagsRelations = relations(menuItemTags, ({ one }) => ({
  item: one(menuItems, {
    fields: [menuItemTags.menuItemId],
    references: [menuItems.id],
  }),
  tag: one(menuTags, {
    fields: [menuItemTags.tagId],
    references: [menuTags.id],
  }),
}))
