import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  branches,
  diningSessions,
  ingredients,
  orderLineModifiers,
  orderLines,
  recipeComponents,
  stockLevels,
  stockMovements,
  suppliers,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import {
  costOf,
  explodeRequirements,
  findShortfalls,
  stockStatus,
  suggestReorders,
  type OrderedItem,
  type RecipeBook,
  type Requirement,
  type StockStatus,
  type StockUnit,
} from './stock'

/**
 * Stock against the database.
 *
 * The engine in `stock.ts` decides the arithmetic; this module supplies the
 * facts and persists the outcome. Every quantity crossing this boundary is
 * an integer count of milli-units.
 */

export type MovementKind =
  | 'receipt'
  | 'consumption'
  | 'return'
  | 'wastage'
  | 'count'
  | 'transfer_out'
  | 'transfer_in'

export interface MovementInput {
  branchId: string
  ingredientId: string
  kind: MovementKind
  /** Signed: negative consumes, positive adds. */
  quantityMilli: number
  reason?: string | null
  sessionId?: string | null
  orderLineId?: string | null
  purchaseOrderId?: string | null
  idempotencyKey?: string | null
  /** Overrides the ingredient's held cost, for a receipt at an agreed price. */
  costPerUnitMinor?: number
}

/**
 * The single write path for stock.
 *
 * Everything that moves stock goes through here — consumption, wastage,
 * receipts, counts, transfers — because the level cache is only trustworthy
 * if there is exactly one place that updates it alongside the ledger. A
 * second path is how the cache and the ledger start disagreeing, and the
 * disagreement is invisible until someone counts the shelf.
 */
export async function recordMovement(
  tx: Transaction,
  restaurantId: string,
  input: MovementInput,
  userId?: string | null,
): Promise<{ id: string; wasReplay: boolean } | null> {
  if (input.quantityMilli === 0) return null

  if (input.idempotencyKey) {
    const [existing] = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.restaurantId, restaurantId),
          eq(stockMovements.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)

    if (existing) return { id: existing.id, wasReplay: true }
  }

  const [ingredient] = await tx
    .select({ costPerUnitMinor: ingredients.costPerUnitMinor })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.id, input.ingredientId),
        eq(ingredients.restaurantId, restaurantId),
      ),
    )
    .limit(1)

  if (!ingredient) throw new NotFoundError('Ingredient not found.')

  const costPerUnitMinor =
    input.costPerUnitMinor ?? ingredient.costPerUnitMinor

  const [movement] = await tx
    .insert(stockMovements)
    .values({
      restaurantId,
      branchId: input.branchId,
      ingredientId: input.ingredientId,
      kind: input.kind,
      quantityMilli: input.quantityMilli,
      costPerUnitMinor,
      // Signed with the quantity, so the ledger's value column sums to the
      // value on hand rather than to the value ever handled.
      valueMinor: costOf(input.quantityMilli, costPerUnitMinor),
      reason: input.reason ?? null,
      sessionId: input.sessionId ?? null,
      orderLineId: input.orderLineId ?? null,
      purchaseOrderId: input.purchaseOrderId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: userId ?? null,
    })
    .returning({ id: stockMovements.id })

  /**
   * Upsert rather than read-modify-write. Two orders consuming the same
   * ingredient at once would both read the same level and both write their
   * own total, losing one deduction entirely; `+ excluded` makes the database
   * do the addition under the row lock it already holds.
   */
  await tx
    .insert(stockLevels)
    .values({
      restaurantId,
      branchId: input.branchId,
      ingredientId: input.ingredientId,
      quantityMilli: input.quantityMilli,
      lastCountedAt: input.kind === 'count' ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [stockLevels.branchId, stockLevels.ingredientId],
      set: {
        quantityMilli: sql`${stockLevels.quantityMilli} + ${input.quantityMilli}`,
        ...(input.kind === 'count' ? { lastCountedAt: new Date() } : {}),
        updatedAt: new Date(),
      },
    })

  return { id: movement.id, wasReplay: false }
}

/** Loads the recipes for a set of menu items and modifier options. */
export async function loadRecipeBookIn(
  tx: Transaction,
  restaurantId: string,
  menuItemIds: string[],
  modifierOptionIds: string[],
): Promise<RecipeBook> {
  const book: RecipeBook = {
    byMenuItem: new Map(),
    byModifierOption: new Map(),
  }

  if (menuItemIds.length === 0 && modifierOptionIds.length === 0) return book

  const rows = await tx
    .select({
      menuItemId: recipeComponents.menuItemId,
      modifierOptionId: recipeComponents.modifierOptionId,
      ingredientId: recipeComponents.ingredientId,
      quantityMilli: recipeComponents.quantityMilli,
    })
    .from(recipeComponents)
    .where(
      and(
        eq(recipeComponents.restaurantId, restaurantId),
        menuItemIds.length > 0 && modifierOptionIds.length > 0
          ? sql`(${inArray(recipeComponents.menuItemId, menuItemIds)} or ${inArray(recipeComponents.modifierOptionId, modifierOptionIds)})`
          : menuItemIds.length > 0
            ? inArray(recipeComponents.menuItemId, menuItemIds)
            : inArray(recipeComponents.modifierOptionId, modifierOptionIds),
      ),
    )

  for (const row of rows) {
    const target = row.menuItemId ? book.byMenuItem : book.byModifierOption
    const key = row.menuItemId ?? row.modifierOptionId
    if (!key) continue

    const list = target.get(key) ?? []
    list.push({
      ingredientId: row.ingredientId,
      quantityMilli: row.quantityMilli,
    })
    target.set(key, list)
  }

  return book
}

/**
 * Freezes what each line cost to make onto the line itself.
 *
 * Consumption movements are merged across a whole order — one movement per
 * ingredient, not per line — so that concurrent orders lock ingredient rows in
 * the same sequence and cannot deadlock. That merge is worth keeping, and it
 * is exactly why the ledger cannot answer "what did this dish cost". This can.
 *
 * The figure uses the ingredient cost in force right now, which is the same
 * cost the movements about to be written will carry. The two agree by
 * construction, and an integration test asserts it rather than trusting it.
 *
 * A line whose item has no recipe is left NULL. Writing zero would report the
 * dish as free to make, which is a claim about the business rather than a gap
 * in the data.
 */
async function snapshotLineCostsIn(
  tx: Transaction,
  restaurantId: string,
  lines: readonly { id: string; menuItemId: string | null; quantity: number }[],
  optionsByLine: Map<string, string[]>,
  book: RecipeBook,
): Promise<void> {
  const costed = lines
    .filter(
      (line): line is (typeof lines)[number] & { menuItemId: string } =>
        Boolean(line.menuItemId),
    )
    .map((line) => ({
      id: line.id,
      requirements: explodeRequirements(
        [
          {
            menuItemId: line.menuItemId,
            quantity: line.quantity,
            modifierOptionIds: optionsByLine.get(line.id) ?? [],
          },
        ],
        book,
      ),
    }))
    .filter((line) => line.requirements.length > 0)

  if (costed.length === 0) return

  const ingredientIds = [
    ...new Set(
      costed.flatMap((line) => line.requirements.map((r) => r.ingredientId)),
    ),
  ]

  const costs = await tx
    .select({
      id: ingredients.id,
      costPerUnitMinor: ingredients.costPerUnitMinor,
    })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.restaurantId, restaurantId),
        inArray(ingredients.id, ingredientIds),
      ),
    )

  const costById = new Map(costs.map((row) => [row.id, row.costPerUnitMinor]))

  for (const line of costed) {
    const costMinor = line.requirements.reduce(
      (total, requirement) =>
        total +
        costOf(
          requirement.quantityMilli,
          costById.get(requirement.ingredientId) ?? 0,
        ),
      0,
    )

    await tx
      .update(orderLines)
      .set({ costMinor })
      .where(eq(orderLines.id, line.id))
  }
}

export interface StockShortfall {
  ingredientId: string
  name: string
  shortMilli: number
}

export interface DeductionResult {
  requirements: Requirement[]
  shortfalls: StockShortfall[]
}

/**
 * Consumes what a set of order lines requires.
 *
 * Idempotent per order line, so a retried order does not write off the
 * ingredients twice.
 *
 * Shortfalls are reported, never enforced. A kitchen that has run out
 * mid-service substitutes or tells the table; it does not stop cooking
 * because the software says so. Refusing the order would mean the POS
 * declines food the kitchen is willing to make, and the immediate workaround
 * is to stop recording stock at all — which costs more than the negative
 * balance did.
 */
export async function deductForOrderLines(
  tx: Transaction,
  restaurantId: string,
  branchId: string,
  sessionId: string,
  lineIds: string[],
  userId?: string | null,
): Promise<DeductionResult> {
  if (lineIds.length === 0) return { requirements: [], shortfalls: [] }

  const lines = await tx
    .select({
      id: orderLines.id,
      menuItemId: orderLines.menuItemId,
      quantity: orderLines.quantity,
    })
    .from(orderLines)
    .where(inArray(orderLines.id, lineIds))

  const modifiers = await tx
    .select({
      orderLineId: orderLineModifiers.orderLineId,
      modifierOptionId: orderLineModifiers.modifierOptionId,
    })
    .from(orderLineModifiers)
    .where(inArray(orderLineModifiers.orderLineId, lineIds))

  const optionsByLine = new Map<string, string[]>()
  for (const modifier of modifiers) {
    if (!modifier.modifierOptionId) continue
    const list = optionsByLine.get(modifier.orderLineId) ?? []
    list.push(modifier.modifierOptionId)
    optionsByLine.set(modifier.orderLineId, list)
  }

  const items: OrderedItem[] = lines
    .filter((line): line is typeof line & { menuItemId: string } =>
      Boolean(line.menuItemId),
    )
    .map((line) => ({
      menuItemId: line.menuItemId,
      quantity: line.quantity,
      modifierOptionIds: optionsByLine.get(line.id) ?? [],
    }))

  const book = await loadRecipeBookIn(
    tx,
    restaurantId,
    items.map((i) => i.menuItemId),
    [...optionsByLine.values()].flat(),
  )

  const requirements = explodeRequirements(items, book)
  if (requirements.length === 0) return { requirements: [], shortfalls: [] }

  await snapshotLineCostsIn(tx, restaurantId, lines, optionsByLine, book)

  const onHand = await tx
    .select({
      ingredientId: stockLevels.ingredientId,
      quantityMilli: stockLevels.quantityMilli,
    })
    .from(stockLevels)
    .where(
      and(
        eq(stockLevels.branchId, branchId),
        inArray(
          stockLevels.ingredientId,
          requirements.map((r) => r.ingredientId),
        ),
      ),
    )

  const short = findShortfalls(requirements, onHand)

  for (const requirement of requirements) {
    await recordMovement(
      tx,
      restaurantId,
      {
        branchId,
        ingredientId: requirement.ingredientId,
        kind: 'consumption',
        quantityMilli: -requirement.quantityMilli,
        sessionId,
        // Keyed on the set of lines, so re-running the same order is a no-op
        // while a later addition to the same bill deducts normally.
        idempotencyKey: `consume:${[...lineIds].sort().join(',')}:${requirement.ingredientId}`,
      },
      userId,
    )
  }

  if (short.length === 0) return { requirements, shortfalls: [] }

  const names = await tx
    .select({ id: ingredients.id, name: ingredients.name })
    .from(ingredients)
    .where(
      inArray(
        ingredients.id,
        short.map((s) => s.ingredientId),
      ),
    )

  const nameById = new Map(names.map((n) => [n.id, n.name]))

  return {
    requirements,
    shortfalls: short.map((s) => ({
      ingredientId: s.ingredientId,
      name: nameById.get(s.ingredientId) ?? 'Unknown ingredient',
      shortMilli: s.requiredMilli - s.availableMilli,
    })),
  }
}

/**
 * Returns stock when an order line is voided.
 *
 * Reverses the consumption rather than deleting it. The ledger is append-only
 * because "why do we think we have 4 kg?" must always have an answer, and a
 * deleted row is the one answer it cannot give.
 */
export async function returnForVoidedLine(
  tx: Transaction,
  restaurantId: string,
  branchId: string,
  sessionId: string,
  lineId: string,
  userId?: string | null,
): Promise<void> {
  const consumed = await tx
    .select({
      ingredientId: stockMovements.ingredientId,
      quantityMilli: stockMovements.quantityMilli,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.restaurantId, restaurantId),
        eq(stockMovements.sessionId, sessionId),
        eq(stockMovements.kind, 'consumption'),
      ),
    )

  if (consumed.length === 0) return

  const [line] = await tx
    .select({
      menuItemId: orderLines.menuItemId,
      quantity: orderLines.quantity,
    })
    .from(orderLines)
    .where(eq(orderLines.id, lineId))
    .limit(1)

  if (!line?.menuItemId) return

  const options = await tx
    .select({ modifierOptionId: orderLineModifiers.modifierOptionId })
    .from(orderLineModifiers)
    .where(eq(orderLineModifiers.orderLineId, lineId))

  const optionIds = options
    .map((o) => o.modifierOptionId)
    .filter((id): id is string => Boolean(id))

  const book = await loadRecipeBookIn(
    tx,
    restaurantId,
    [line.menuItemId],
    optionIds,
  )

  const requirements = explodeRequirements(
    [
      {
        menuItemId: line.menuItemId,
        quantity: line.quantity,
        modifierOptionIds: optionIds,
      },
    ],
    book,
  )

  for (const requirement of requirements) {
    await recordMovement(
      tx,
      restaurantId,
      {
        branchId,
        ingredientId: requirement.ingredientId,
        kind: 'return',
        quantityMilli: requirement.quantityMilli,
        reason: 'Order line voided',
        sessionId,
        orderLineId: lineId,
        idempotencyKey: `return:${lineId}:${requirement.ingredientId}`,
      },
      userId,
    )
  }
}

/** Resolves the branch a session belongs to, for movements caused by orders. */
export async function branchForSessionIn(
  tx: Transaction,
  sessionId: string,
): Promise<string | null> {
  const [session] = await tx
    .select({ branchId: diningSessions.branchId })
    .from(diningSessions)
    .where(eq(diningSessions.id, sessionId))
    .limit(1)

  return session?.branchId ?? null
}

// --- ingredients ---

export interface IngredientRow {
  id: string
  name: string
  category: string | null
  unit: StockUnit
  costPerUnitMinor: number
  reorderPointMilli: number
  reorderQuantityMilli: number
  preferredSupplierId: string | null
  supplierName: string | null
  isActive: boolean
}

export async function listIngredients(
  restaurantId: string,
  userId: string,
): Promise<IngredientRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: ingredients.id,
        name: ingredients.name,
        category: ingredients.category,
        unit: ingredients.unit,
        costPerUnitMinor: ingredients.costPerUnitMinor,
        reorderPointMilli: ingredients.reorderPointMilli,
        reorderQuantityMilli: ingredients.reorderQuantityMilli,
        preferredSupplierId: ingredients.preferredSupplierId,
        supplierName: suppliers.name,
        isActive: ingredients.isActive,
      })
      .from(ingredients)
      .leftJoin(suppliers, eq(suppliers.id, ingredients.preferredSupplierId))
      .where(eq(ingredients.restaurantId, restaurantId))
      .orderBy(asc(ingredients.name)),
  )
}

export interface CreateIngredientInput {
  name: string
  category?: string | null
  unit: StockUnit
  costPerUnitMinor: number
  reorderPointMilli: number
  reorderQuantityMilli: number
  preferredSupplierId?: string | null
}

export async function createIngredient(
  ctx: BranchActorContext,
  input: CreateIngredientInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [clash] = await tx
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(
        and(
          eq(ingredients.restaurantId, ctx.restaurantId),
          eq(ingredients.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(
        `An ingredient called "${input.name}" already exists.`,
      )
    }

    const [created] = await tx
      .insert(ingredients)
      .values({
        restaurantId: ctx.restaurantId,
        name: input.name,
        category: input.category ?? null,
        unit: input.unit,
        costPerUnitMinor: input.costPerUnitMinor,
        reorderPointMilli: input.reorderPointMilli,
        reorderQuantityMilli: input.reorderQuantityMilli,
        preferredSupplierId: input.preferredSupplierId ?? null,
      })
      .returning({ id: ingredients.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'ingredient.created',
      entityType: 'ingredient',
      entityId: created.id,
      after: { name: input.name, unit: input.unit },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

// --- recipes ---

export async function setRecipe(
  ctx: BranchActorContext,
  target: { menuItemId?: string; modifierOptionId?: string },
  components: { ingredientId: string; quantityMilli: number }[],
): Promise<void> {
  if (!target.menuItemId === !target.modifierOptionId) {
    throw new ValidationError(
      'A recipe belongs to a menu item or a modifier option, not both.',
    )
  }

  const seen = new Set<string>()
  for (const component of components) {
    if (component.quantityMilli <= 0) {
      throw new ValidationError('Each ingredient needs a quantity above zero.')
    }
    if (seen.has(component.ingredientId)) {
      throw new ValidationError(
        'The same ingredient is listed twice, which would deduct it twice.',
      )
    }
    seen.add(component.ingredientId)
  }

  await withTenant(ctx, async (tx) => {
    // Replaced wholesale rather than diffed: the recipe as submitted is the
    // recipe, and a partial update would leave removed ingredients deducting.
    await tx
      .delete(recipeComponents)
      .where(
        and(
          eq(recipeComponents.restaurantId, ctx.restaurantId),
          target.menuItemId
            ? eq(recipeComponents.menuItemId, target.menuItemId)
            : eq(recipeComponents.modifierOptionId, target.modifierOptionId!),
        ),
      )

    if (components.length > 0) {
      await tx.insert(recipeComponents).values(
        components.map((component) => ({
          restaurantId: ctx.restaurantId,
          menuItemId: target.menuItemId ?? null,
          modifierOptionId: target.modifierOptionId ?? null,
          ingredientId: component.ingredientId,
          quantityMilli: component.quantityMilli,
        })),
      )
    }

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'recipe.updated',
      entityType: target.menuItemId ? 'menu_item' : 'modifier_option',
      entityId: target.menuItemId ?? target.modifierOptionId!,
      after: { components },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function readRecipe(
  restaurantId: string,
  userId: string,
  target: { menuItemId?: string; modifierOptionId?: string },
): Promise<{ ingredientId: string; name: string; unit: StockUnit; quantityMilli: number }[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        ingredientId: recipeComponents.ingredientId,
        name: ingredients.name,
        unit: ingredients.unit,
        quantityMilli: recipeComponents.quantityMilli,
      })
      .from(recipeComponents)
      .innerJoin(ingredients, eq(ingredients.id, recipeComponents.ingredientId))
      .where(
        and(
          eq(recipeComponents.restaurantId, restaurantId),
          target.menuItemId
            ? eq(recipeComponents.menuItemId, target.menuItemId)
            : eq(
                recipeComponents.modifierOptionId,
                target.modifierOptionId ?? '',
              ),
        ),
      )
      .orderBy(asc(ingredients.name)),
  )
}

// --- levels and movements ---

export interface StockRow {
  ingredientId: string
  name: string
  category: string | null
  unit: StockUnit
  quantityMilli: number
  reorderPointMilli: number
  reorderQuantityMilli: number
  costPerUnitMinor: number
  valueMinor: number
  status: StockStatus
  lastCountedAt: Date | null
}

export async function listStock(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<StockRow[]> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const rows = await tx
      .select({
        ingredientId: ingredients.id,
        name: ingredients.name,
        category: ingredients.category,
        unit: ingredients.unit,
        costPerUnitMinor: ingredients.costPerUnitMinor,
        reorderPointMilli: ingredients.reorderPointMilli,
        reorderQuantityMilli: ingredients.reorderQuantityMilli,
        quantityMilli: stockLevels.quantityMilli,
        lastCountedAt: stockLevels.lastCountedAt,
      })
      .from(ingredients)
      /**
       * Left join, not inner. An ingredient that has never moved at this
       * branch has no level row, and it is precisely the one a manager needs
       * to see — inner-joining would hide every item that is out of stock
       * because it was never delivered.
       */
      .leftJoin(
        stockLevels,
        and(
          eq(stockLevels.ingredientId, ingredients.id),
          eq(stockLevels.branchId, branchId),
        ),
      )
      .where(
        and(
          eq(ingredients.restaurantId, restaurantId),
          eq(ingredients.isActive, true),
        ),
      )
      .orderBy(asc(ingredients.name))

    return rows.map((row) => {
      const quantityMilli = row.quantityMilli ?? 0

      return {
        ...row,
        quantityMilli,
        valueMinor: costOf(Math.max(0, quantityMilli), row.costPerUnitMinor),
        status: stockStatus(quantityMilli, row.reorderPointMilli),
        lastCountedAt: row.lastCountedAt ?? null,
      }
    })
  })
}

export async function listReorderSuggestions(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<
  { ingredientId: string; name: string; unit: StockUnit; suggestedMilli: number; status: StockStatus }[]
> {
  const stock = await listStock(restaurantId, userId, branchId)
  const byId = new Map(stock.map((row) => [row.ingredientId, row]))

  return suggestReorders(
    stock.map((row) => ({
      ingredientId: row.ingredientId,
      quantityMilli: row.quantityMilli,
      reorderPointMilli: row.reorderPointMilli,
      reorderQuantityMilli: row.reorderQuantityMilli,
    })),
  ).map((suggestion) => {
    const row = byId.get(suggestion.ingredientId)!
    return {
      ingredientId: suggestion.ingredientId,
      name: row.name,
      unit: row.unit,
      suggestedMilli: suggestion.suggestedMilli,
      status: suggestion.status,
    }
  })
}

export async function listMovements(
  restaurantId: string,
  userId: string,
  branchId: string,
  ingredientId?: string,
  limit = 100,
): Promise<
  {
    id: string
    kind: MovementKind
    quantityMilli: number
    valueMinor: number
    reason: string | null
    name: string
    unit: StockUnit
    createdAt: Date
  }[]
> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: stockMovements.id,
        kind: stockMovements.kind,
        quantityMilli: stockMovements.quantityMilli,
        valueMinor: stockMovements.valueMinor,
        reason: stockMovements.reason,
        name: ingredients.name,
        unit: ingredients.unit,
        createdAt: stockMovements.createdAt,
      })
      .from(stockMovements)
      .innerJoin(ingredients, eq(ingredients.id, stockMovements.ingredientId))
      .where(
        and(
          eq(stockMovements.restaurantId, restaurantId),
          eq(stockMovements.branchId, branchId),
          ingredientId
            ? eq(stockMovements.ingredientId, ingredientId)
            : undefined,
        ),
      )
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit),
  )
}

export async function recordWastage(
  ctx: BranchActorContext,
  branchId: string,
  ingredientId: string,
  quantityMilli: number,
  reason: string,
): Promise<void> {
  if (!Number.isInteger(quantityMilli) || quantityMilli <= 0) {
    throw new ValidationError('Enter a quantity greater than zero.', {
      quantityMilli: ['Enter a quantity greater than zero.'],
    })
  }

  await withTenant(ctx, async (tx) => {
    await recordMovement(
      tx,
      ctx.restaurantId,
      {
        branchId,
        ingredientId,
        kind: 'wastage',
        // Negative: wastage takes stock off the shelf and value off the books.
        quantityMilli: -quantityMilli,
        reason,
      },
      ctx.userId,
    )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'stock.wasted',
      entityType: 'ingredient',
      entityId: ingredientId,
      after: { branchId, quantityMilli, reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Corrects a level to what was physically counted.
 *
 * Takes the counted quantity, not a delta, and derives the adjustment. A
 * person holding a clipboard knows there are 4 kg on the shelf; asking them
 * to work out that this is 1.4 kg less than the system thinks is asking them
 * to do arithmetic under time pressure, and the mistakes go straight into the
 * books.
 */
export async function recordCount(
  ctx: BranchActorContext,
  branchId: string,
  ingredientId: string,
  countedMilli: number,
  reason?: string,
): Promise<{ adjustmentMilli: number }> {
  if (!Number.isInteger(countedMilli) || countedMilli < 0) {
    throw new ValidationError('Enter the quantity counted, which cannot be negative.', {
      countedMilli: ['Enter the quantity counted, which cannot be negative.'],
    })
  }

  return withTenant(ctx, async (tx) => {
    const [level] = await tx
      .select({ quantityMilli: stockLevels.quantityMilli })
      .from(stockLevels)
      .where(
        and(
          eq(stockLevels.branchId, branchId),
          eq(stockLevels.ingredientId, ingredientId),
        ),
      )
      .limit(1)

    const adjustmentMilli = countedMilli - (level?.quantityMilli ?? 0)

    if (adjustmentMilli === 0) {
      // Still stamp the count: "counted, and it was right" is a fact worth
      // recording, and without it the shelf looks like it was never checked.
      await tx
        .update(stockLevels)
        .set({ lastCountedAt: new Date() })
        .where(
          and(
            eq(stockLevels.branchId, branchId),
            eq(stockLevels.ingredientId, ingredientId),
          ),
        )

      return { adjustmentMilli: 0 }
    }

    await recordMovement(
      tx,
      ctx.restaurantId,
      {
        branchId,
        ingredientId,
        kind: 'count',
        quantityMilli: adjustmentMilli,
        reason: reason ?? 'Stock count',
      },
      ctx.userId,
    )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'stock.counted',
      entityType: 'ingredient',
      entityId: ingredientId,
      before: { quantityMilli: level?.quantityMilli ?? 0 },
      after: { quantityMilli: countedMilli, adjustmentMilli },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { adjustmentMilli }
  })
}

export async function transferStock(
  ctx: BranchActorContext,
  fromBranchId: string,
  toBranchId: string,
  ingredientId: string,
  quantityMilli: number,
): Promise<void> {
  if (fromBranchId === toBranchId) {
    throw new ValidationError('Choose two different branches.')
  }
  if (!Number.isInteger(quantityMilli) || quantityMilli <= 0) {
    throw new ValidationError('Enter a quantity greater than zero.')
  }

  await withTenant(ctx, async (tx) => {
    const [destination] = await tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(
        and(
          eq(branches.id, toBranchId),
          eq(branches.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!destination) throw new NotFoundError('Destination branch not found.')

    /**
     * Two movements, not one. A transfer is a departure and an arrival, and
     * modelling it as a single row would leave the sending branch's ledger
     * unable to explain where the stock went.
     */
    await recordMovement(
      tx,
      ctx.restaurantId,
      {
        branchId: fromBranchId,
        ingredientId,
        kind: 'transfer_out',
        quantityMilli: -quantityMilli,
        reason: `Transferred to ${destination.name}`,
      },
      ctx.userId,
    )

    await recordMovement(
      tx,
      ctx.restaurantId,
      {
        branchId: toBranchId,
        ingredientId,
        kind: 'transfer_in',
        quantityMilli,
        reason: 'Transferred in',
      },
      ctx.userId,
    )
  })
}

/**
 * Recomputes every cached level at a branch from the ledger and reports drift.
 *
 * The cache exists for speed, and a cache nobody checks is a cache nobody can
 * trust. This is what makes the trade-off defensible rather than merely
 * convenient — an integration test runs it after a service's worth of
 * movements and asserts nothing drifted.
 */
export async function reconcileStock(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<{ ingredientId: string; cachedMilli: number; ledgerMilli: number }[]> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const ledger = await tx
      .select({
        ingredientId: stockMovements.ingredientId,
        total: sql<number>`coalesce(sum(${stockMovements.quantityMilli}), 0)::int`,
      })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.restaurantId, restaurantId),
          eq(stockMovements.branchId, branchId),
        ),
      )
      .groupBy(stockMovements.ingredientId)

    const cached = await tx
      .select({
        ingredientId: stockLevels.ingredientId,
        quantityMilli: stockLevels.quantityMilli,
      })
      .from(stockLevels)
      .where(eq(stockLevels.branchId, branchId))

    const cachedById = new Map(
      cached.map((row) => [row.ingredientId, row.quantityMilli]),
    )

    const drift: {
      ingredientId: string
      cachedMilli: number
      ledgerMilli: number
    }[] = []

    for (const row of ledger) {
      const cachedMilli = cachedById.get(row.ingredientId) ?? 0
      if (cachedMilli !== row.total) {
        drift.push({
          ingredientId: row.ingredientId,
          cachedMilli,
          ledgerMilli: row.total,
        })
      }
      cachedById.delete(row.ingredientId)
    }

    // Anything left has a cached level but no movements behind it, which is
    // drift in the other direction and just as wrong.
    for (const [ingredientId, cachedMilli] of cachedById) {
      if (cachedMilli !== 0) {
        drift.push({ ingredientId, cachedMilli, ledgerMilli: 0 })
      }
    }

    return drift
  })
}
