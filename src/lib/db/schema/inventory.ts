import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

import { branches, restaurants } from './tenancy'
import { menuItems } from './menu'
import { modifierOptions } from './modifiers'
import { diningSessions, orderLines } from './session'
import { users } from './identity'
import { tenantPolicy, timestamps } from './_shared'

/**
 * Inventory, suppliers and purchasing.
 *
 * Every quantity here is an integer count of milli-units — one thousandth of
 * the ingredient's stock unit. See `src/modules/inventory/stock.ts` for why
 * floats are not an option.
 */

export const stockUnit = pgEnum('stock_unit', ['kg', 'l', 'each'])

export const stockMovementKind = pgEnum('stock_movement_kind', [
  /** Goods received against a purchase order. */
  'receipt',
  /** Consumed by an order. */
  'consumption',
  /** Returned when an order line is voided. */
  'return',
  /** Spoiled, dropped, burnt, expired. */
  'wastage',
  /** A physical count correcting the books to the shelf. */
  'count',
  /** Sent to another branch. */
  'transfer_out',
  /** Arrived from another branch. */
  'transfer_in',
])

export const purchaseOrderStatus = pgEnum('purchase_order_status', [
  'draft',
  'approved',
  'partially_received',
  'received',
  'cancelled',
])

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    contactName: text('contact_name'),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),

    /** Days from invoice to payment. Zero means cash on delivery. */
    paymentTermDays: integer('payment_term_days').notNull().default(0),
    notes: text('notes'),

    isActive: boolean('is_active').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('suppliers_restaurant_name_key').on(t.restaurantId, t.name),
    tenantPolicy('suppliers_tenant_isolation', t.restaurantId),
  ],
)

export const ingredients = pgTable(
  'ingredients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** Free text rather than a table: "Dry goods", "Produce", "Bar". */
    category: text('category'),

    unit: stockUnit('unit').notNull(),

    /**
     * Weighted average cost of one whole stock unit, in minor currency units.
     * Recalculated on every goods receipt.
     */
    costPerUnitMinor: integer('cost_per_unit_minor').notNull().default(0),

    /** Order when the level reaches this. Zero disables the alert. */
    reorderPointMilli: integer('reorder_point_milli').notNull().default(0),
    /** The standard amount to order when topping up. */
    reorderQuantityMilli: integer('reorder_quantity_milli')
      .notNull()
      .default(0),

    preferredSupplierId: uuid('preferred_supplier_id').references(
      () => suppliers.id,
      { onDelete: 'set null' },
    ),

    isActive: boolean('is_active').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('ingredients_restaurant_name_key').on(t.restaurantId, t.name),
    index('ingredients_supplier_idx').on(t.preferredSupplierId),
    tenantPolicy('ingredients_tenant_isolation', t.restaurantId),
  ],
)

/**
 * What a menu item or modifier option consumes.
 *
 * One table with two nullable parents rather than two tables, because every
 * read wants both at once — an order consumes the dish *and* its modifiers,
 * and splitting them would mean two queries and a merge on every order.
 *
 * A partial unique index per parent keeps an ingredient from appearing twice
 * on the same recipe, which would silently double the deduction.
 */
export const recipeComponents = pgTable(
  'recipe_components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    menuItemId: uuid('menu_item_id').references(() => menuItems.id, {
      onDelete: 'cascade',
    }),
    modifierOptionId: uuid('modifier_option_id').references(
      () => modifierOptions.id,
      { onDelete: 'cascade' },
    ),

    ingredientId: uuid('ingredient_id')
      .notNull()
      .references(() => ingredients.id, { onDelete: 'cascade' }),

    /** Milli-units consumed per one unit of the parent. */
    quantityMilli: integer('quantity_milli').notNull(),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('recipe_components_item_ingredient_key')
      .on(t.menuItemId, t.ingredientId)
      .where(sql`menu_item_id is not null`),
    uniqueIndex('recipe_components_option_ingredient_key')
      .on(t.modifierOptionId, t.ingredientId)
      .where(sql`modifier_option_id is not null`),
    index('recipe_components_ingredient_idx').on(t.ingredientId),
    tenantPolicy('recipe_components_tenant_isolation', t.restaurantId),
  ],
)

/**
 * Current quantity of an ingredient at a branch.
 *
 * This is a cache. The `stock_movements` ledger below is the source of truth,
 * and `reconcileStock` recomputes this from it.
 *
 * Loyalty deliberately has no cached balance; inventory does, and the reason
 * is the access pattern rather than a change of principle. A customer's
 * ledger is tens of rows read when they are standing at the till. An
 * ingredient's ledger grows by a row per order line per service, and it is
 * read on every order to check availability. Summing it each time would make
 * ordering slower the longer the restaurant has been open.
 *
 * The cache is safe only because there is exactly one write path — every
 * movement goes through `recordMovement`, which inserts the ledger row and
 * updates this in the same transaction. An integration test asserts the two
 * agree.
 */
export const stockLevels = pgTable(
  'stock_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    ingredientId: uuid('ingredient_id')
      .notNull()
      .references(() => ingredients.id, { onDelete: 'cascade' }),

    quantityMilli: integer('quantity_milli').notNull().default(0),

    /**
     * Nullable, and null means never counted — which is a different fact from
     * counted long ago, and the one a manager needs to see.
     */
    lastCountedAt: timestamp('last_counted_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('stock_levels_branch_ingredient_key').on(
      t.branchId,
      t.ingredientId,
    ),
    index('stock_levels_ingredient_idx').on(t.ingredientId),
    tenantPolicy('stock_levels_tenant_isolation', t.restaurantId),
  ],
)

/**
 * Every change to a stock level, append-only.
 *
 * Nothing here is ever updated or deleted. A correction is a new row, so the
 * question "why do we think we have 4 kg?" always has an answer.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    ingredientId: uuid('ingredient_id')
      .notNull()
      .references(() => ingredients.id, { onDelete: 'cascade' }),

    kind: stockMovementKind('kind').notNull(),

    /** Signed: negative consumes, positive adds. The sum is the level. */
    quantityMilli: integer('quantity_milli').notNull(),

    /**
     * Cost per unit at the moment of the movement, snapshotted.
     *
     * Without this, last month's consumption would be revalued every time a
     * delivery changes the average, and a closed month's food cost would
     * move after it was reported.
     */
    costPerUnitMinor: integer('cost_per_unit_minor').notNull().default(0),
    /** Signed total value of this movement, in minor units. */
    valueMinor: integer('value_minor').notNull().default(0),

    reason: text('reason'),

    // --- what caused it, where applicable ---
    sessionId: uuid('session_id').references(() => diningSessions.id, {
      onDelete: 'set null',
    }),
    orderLineId: uuid('order_line_id').references(() => orderLines.id, {
      onDelete: 'set null',
    }),
    /**
     * Lazy reference: `purchaseOrders` is declared below this table, and the
     * callback form defers resolution until both exist.
     */
    purchaseOrderId: uuid('purchase_order_id').references(
      (): AnyPgColumn => purchaseOrders.id,
      { onDelete: 'set null' },
    ),

    /**
     * Makes a repeated deduction a no-op rather than a second write-off. An
     * order retried after a timeout must not consume the ingredients twice.
     */
    idempotencyKey: text('idempotency_key'),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('stock_movements_idempotency_key')
      .on(t.restaurantId, t.idempotencyKey)
      .where(sql`idempotency_key is not null`),
    index('stock_movements_branch_ingredient_idx').on(
      t.branchId,
      t.ingredientId,
      t.createdAt,
    ),
    index('stock_movements_session_idx').on(t.sessionId),
    tenantPolicy('stock_movements_tenant_isolation', t.restaurantId),
  ],
)

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),

    /** Human reference: PO-000123. Unique per restaurant. */
    reference: text('reference').notNull(),

    status: purchaseOrderStatus('status').notNull().default('draft'),

    expectedAt: timestamp('expected_at', { withTimezone: true }),
    notes: text('notes'),

    /** Sum of the line totals as ordered, in minor units. */
    totalMinor: integer('total_minor').notNull().default(0),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * Who authorised the spend. Separate from the creator because a purchase
     * order approved by the person who raised it is not an approval.
     */
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('purchase_orders_restaurant_reference_key').on(
      t.restaurantId,
      t.reference,
    ),
    index('purchase_orders_supplier_idx').on(t.supplierId),
    index('purchase_orders_status_idx').on(t.restaurantId, t.status),
    tenantPolicy('purchase_orders_tenant_isolation', t.restaurantId),
  ],
)

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    ingredientId: uuid('ingredient_id')
      .notNull()
      .references(() => ingredients.id, { onDelete: 'restrict' }),

    /**
     * Snapshotted at the time of ordering. Renaming an ingredient must not
     * rewrite what a delivered purchase order says was bought.
     */
    nameSnapshot: text('name_snapshot').notNull(),
    unitSnapshot: stockUnit('unit_snapshot').notNull(),

    orderedMilli: integer('ordered_milli').notNull(),
    receivedMilli: integer('received_milli').notNull().default(0),

    /** Agreed price per whole unit, which may differ from the held cost. */
    unitCostMinor: integer('unit_cost_minor').notNull(),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('purchase_order_lines_order_ingredient_key').on(
      t.purchaseOrderId,
      t.ingredientId,
    ),
    tenantPolicy('purchase_order_lines_tenant_isolation', t.restaurantId),
  ],
)

// --- relations ---

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  ingredients: many(ingredients),
  purchaseOrders: many(purchaseOrders),
}))

export const ingredientsRelations = relations(
  ingredients,
  ({ one, many }) => ({
    preferredSupplier: one(suppliers, {
      fields: [ingredients.preferredSupplierId],
      references: [suppliers.id],
    }),
    stockLevels: many(stockLevels),
    movements: many(stockMovements),
  }),
)

export const recipeComponentsRelations = relations(
  recipeComponents,
  ({ one }) => ({
    ingredient: one(ingredients, {
      fields: [recipeComponents.ingredientId],
      references: [ingredients.id],
    }),
    menuItem: one(menuItems, {
      fields: [recipeComponents.menuItemId],
      references: [menuItems.id],
    }),
    modifierOption: one(modifierOptions, {
      fields: [recipeComponents.modifierOptionId],
      references: [modifierOptions.id],
    }),
  }),
)

export const stockLevelsRelations = relations(stockLevels, ({ one }) => ({
  ingredient: one(ingredients, {
    fields: [stockLevels.ingredientId],
    references: [ingredients.id],
  }),
  branch: one(branches, {
    fields: [stockLevels.branchId],
    references: [branches.id],
  }),
}))

export const purchaseOrdersRelations = relations(
  purchaseOrders,
  ({ one, many }) => ({
    supplier: one(suppliers, {
      fields: [purchaseOrders.supplierId],
      references: [suppliers.id],
    }),
    branch: one(branches, {
      fields: [purchaseOrders.branchId],
      references: [branches.id],
    }),
    lines: many(purchaseOrderLines),
  }),
)

export const purchaseOrderLinesRelations = relations(
  purchaseOrderLines,
  ({ one }) => ({
    purchaseOrder: one(purchaseOrders, {
      fields: [purchaseOrderLines.purchaseOrderId],
      references: [purchaseOrders.id],
    }),
    ingredient: one(ingredients, {
      fields: [purchaseOrderLines.ingredientId],
      references: [ingredients.id],
    }),
  }),
)
