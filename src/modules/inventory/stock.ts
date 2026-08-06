/**
 * Stock arithmetic. Pure — no database, no clock, no I/O.
 *
 * Every quantity in this module is an integer count of **milli-units**: one
 * thousandth of the ingredient's stock unit. An ingredient held in kilograms
 * stores 250 g as 250; one held as `each` stores 3 pieces as 3000.
 *
 * Floats are not an option. A recipe using 0.1 kg three times must consume
 * exactly 0.3 kg, and `0.1 + 0.1 + 0.1 !== 0.3` in IEEE 754. The same reason
 * money is held in minor units applies here, and for the same reason it is
 * enforced by the type rather than by remembering.
 */

/** How an ingredient is bought, counted and costed. */
export type StockUnit = 'kg' | 'l' | 'each'

export const MILLI = 1000

/** Human label for a milli-unit quantity: 1250 kg-milli → "1.25 kg". */
export function formatQuantity(milli: number, unit: StockUnit): string {
  const whole = milli / MILLI

  if (unit === 'each') {
    // Pieces are usually whole, and "3.000 each" reads like a measurement
    // error rather than three bread rolls.
    return Number.isInteger(whole)
      ? `${whole} ${whole === 1 ? 'piece' : 'pieces'}`
      : `${whole.toFixed(3).replace(/0+$/, '')} pieces`
  }

  return `${whole.toFixed(3).replace(/\.?0+$/, '')} ${unit}`
}

export interface RecipeComponent {
  ingredientId: string
  /** Milli-units consumed per one unit of the menu item. */
  quantityMilli: number
}

export interface OrderedItem {
  menuItemId: string
  quantity: number
  /** Modifier options chosen, each of which may carry its own recipe. */
  modifierOptionIds: string[]
}

export interface RecipeBook {
  /** Components keyed by menu item id. */
  byMenuItem: Map<string, RecipeComponent[]>
  /** Components keyed by modifier option id. */
  byModifierOption: Map<string, RecipeComponent[]>
}

export interface Requirement {
  ingredientId: string
  quantityMilli: number
}

/**
 * Works out everything an order consumes.
 *
 * Modifier recipes are added on top of the item's own, because "extra cheese"
 * is a real 20 g of cheese that leaves the fridge. Ignoring modifiers is the
 * quiet way an inventory system drifts: the counts look plausible for months
 * and are wrong by exactly the amount of every upsell.
 *
 * Requirements for the same ingredient are merged, so a dish whose base and
 * modifier both use butter produces one deduction rather than two — halving
 * the ledger rows and making the movement legible.
 */
export function explodeRequirements(
  items: OrderedItem[],
  recipes: RecipeBook,
): Requirement[] {
  const totals = new Map<string, number>()

  const add = (components: RecipeComponent[], multiplier: number) => {
    for (const component of components) {
      if (component.quantityMilli <= 0) continue
      totals.set(
        component.ingredientId,
        (totals.get(component.ingredientId) ?? 0) +
          component.quantityMilli * multiplier,
      )
    }
  }

  for (const item of items) {
    if (item.quantity <= 0) continue

    add(recipes.byMenuItem.get(item.menuItemId) ?? [], item.quantity)

    for (const optionId of item.modifierOptionIds) {
      add(recipes.byModifierOption.get(optionId) ?? [], item.quantity)
    }
  }

  /**
   * Sorted by ingredient id so the deduction order is deterministic. Two
   * concurrent orders touching the same ingredients then lock rows in the
   * same sequence and cannot deadlock against each other.
   */
  return [...totals.entries()]
    .map(([ingredientId, quantityMilli]) => ({ ingredientId, quantityMilli }))
    .sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : 1))
}

export interface StockOnHand {
  ingredientId: string
  quantityMilli: number
}

export interface Shortfall {
  ingredientId: string
  requiredMilli: number
  availableMilli: number
}

/**
 * Reports what an order would run short of.
 *
 * Reporting rather than refusing is deliberate. A kitchen that has run out of
 * an ingredient mid-service does not stop cooking — it substitutes, or it
 * tells the table. Blocking the order would mean the POS refuses food the
 * kitchen is willing to make, and the immediate workaround is to stop
 * recording stock at all.
 */
export function findShortfalls(
  requirements: Requirement[],
  onHand: StockOnHand[],
): Shortfall[] {
  const available = new Map(
    onHand.map((row) => [row.ingredientId, row.quantityMilli]),
  )

  return requirements
    .filter((r) => (available.get(r.ingredientId) ?? 0) < r.quantityMilli)
    .map((r) => ({
      ingredientId: r.ingredientId,
      requiredMilli: r.quantityMilli,
      availableMilli: available.get(r.ingredientId) ?? 0,
    }))
}

/**
 * Cost of consuming a quantity, given a cost per whole stock unit.
 *
 * `costPerUnitMinor` is the cost of one kilogram, one litre or one piece in
 * minor currency units. Consuming 250 milli of a RM 12.00/kg ingredient costs
 * `250 × 1200 / 1000` = 300, or RM 3.00.
 *
 * Rounded half-up at the end rather than per component, so a dish using three
 * ingredients is costed once rather than absorbing three separate roundings.
 */
export function costOf(quantityMilli: number, costPerUnitMinor: number): number {
  return Math.round((quantityMilli * costPerUnitMinor) / MILLI)
}

export interface WeightedAverageInput {
  onHandMilli: number
  currentCostPerUnitMinor: number
  receivedMilli: number
  receivedCostPerUnitMinor: number
}

/**
 * New weighted average cost after receiving a delivery.
 *
 * Weighted average rather than FIFO. FIFO is more accurate and needs every
 * receipt kept as a separate costed layer that consumption draws down in
 * order — a materially larger model, for a restaurant whose stock turns over
 * in days. Weighted average is the standard for exactly this case, and moving
 * to FIFO later is a new table rather than a rewrite.
 *
 * Negative stock on hand — which happens when deduction outruns receiving —
 * is floored at zero for the purpose of the average. Letting it weight the
 * calculation would drag the new cost away from what was actually just paid,
 * and a negative balance is a counting error, not a valuation.
 */
export function weightedAverageCost({
  onHandMilli,
  currentCostPerUnitMinor,
  receivedMilli,
  receivedCostPerUnitMinor,
}: WeightedAverageInput): number {
  const existing = Math.max(0, onHandMilli)

  if (receivedMilli <= 0) return currentCostPerUnitMinor
  if (existing === 0) return receivedCostPerUnitMinor

  const existingValue = existing * currentCostPerUnitMinor
  const receivedValue = receivedMilli * receivedCostPerUnitMinor

  return Math.round((existingValue + receivedValue) / (existing + receivedMilli))
}

export type StockStatus = 'out' | 'low' | 'ok'

/**
 * Classifies a level against its reorder point.
 *
 * `out` is strictly at or below zero rather than "below the point", because a
 * kitchen treats "we have none" and "we are nearly out" as different
 * problems — one stops service, the other prompts an order.
 */
export function stockStatus(
  quantityMilli: number,
  reorderPointMilli: number,
): StockStatus {
  if (quantityMilli <= 0) return 'out'
  if (reorderPointMilli > 0 && quantityMilli <= reorderPointMilli) return 'low'
  return 'ok'
}

export interface ReorderCandidate {
  ingredientId: string
  quantityMilli: number
  reorderPointMilli: number
  reorderQuantityMilli: number
}

export interface ReorderSuggestion {
  ingredientId: string
  /** How much to order, in milli-units. */
  suggestedMilli: number
  status: StockStatus
}

/**
 * Suggests what to reorder and how much.
 *
 * Tops up to the reorder point plus the standard order quantity, rather than
 * ordering a flat amount. An ingredient sitting just under its point and one
 * that has run out entirely need different deliveries, and a fixed quantity
 * would under-serve the second every time.
 */
export function suggestReorders(
  candidates: ReorderCandidate[],
): ReorderSuggestion[] {
  return candidates
    .map((candidate) => ({
      ingredientId: candidate.ingredientId,
      status: stockStatus(candidate.quantityMilli, candidate.reorderPointMilli),
      suggestedMilli:
        candidate.reorderPointMilli +
        candidate.reorderQuantityMilli -
        Math.max(0, candidate.quantityMilli),
    }))
    .filter((s) => s.status !== 'ok' && s.suggestedMilli > 0)
    .sort((a, b) => {
      // Out-of-stock first: it is the one already costing sales.
      if (a.status !== b.status) return a.status === 'out' ? -1 : 1
      return a.ingredientId < b.ingredientId ? -1 : 1
    })
}
