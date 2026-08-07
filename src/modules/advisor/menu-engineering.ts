/**
 * Menu engineering.
 *
 * The classic Kasavana–Smith matrix: every dish is placed by how often it
 * sells against how much it contributes, and each of the four quadrants
 * implies a different action. It is the oldest useful idea in restaurant
 * analytics and it is entirely arithmetic — which is why it lives here, pure
 * and testable, rather than being asked of a language model.
 *
 * Two things are done differently from the textbook, both deliberately.
 *
 * First, a dish with no recipe is not classified at all. The textbook assumes
 * every item is costed; this system knows perfectly well when it is not, and
 * guessing a contribution from a cost of zero would place every uncosted dish
 * in the star quadrant and recommend featuring it.
 *
 * Second, nothing is classified from too few sales. A dish that sold twice is
 * not unpopular; it is unmeasured.
 */

export interface MenuItemPerformance {
  menuItemId: string | null
  name: string
  categoryName: string | null
  quantity: number
  revenueMinor: number
  costMinor: number
  /** False when the item has no recipe, so cost is unknown rather than zero. */
  isCosted: boolean
}

export type MenuQuadrant =
  /** Popular and profitable. Protect it. */
  | 'star'
  /** Popular but thin. The kitchen works hard for little. */
  | 'plowhorse'
  /** Profitable but nobody orders it. */
  | 'puzzle'
  /** Neither. A candidate for removal. */
  | 'dog'

export interface ClassifiedItem extends MenuItemPerformance {
  quadrant: MenuQuadrant
  /** Gross profit on this item over the period. */
  contributionMinor: number
  /** Gross profit per unit sold — what the matrix actually ranks on. */
  unitContributionMinor: number
  marginBasisPoints: number | null
  /** This item's share of all units sold, in basis points. */
  popularityBasisPoints: number
}

export interface MenuAnalysis {
  items: ClassifiedItem[]
  /** Items left out, and why — never silently dropped. */
  excluded: { name: string; reason: 'no_recipe' | 'too_few_sales' }[]
  /** The unit contribution an item must beat to count as profitable. */
  contributionThresholdMinor: number
  /** The share of units an item must beat to count as popular. */
  popularityThresholdBasisPoints: number
}

/**
 * Below this, a dish has not sold often enough to be judged.
 *
 * Ten is not a statistical threshold and does not pretend to be. It is the
 * point below which a manager reading "remove this dish" would reasonably ask
 * "on the strength of what?" — and be right.
 */
export const MIN_SALES_TO_CLASSIFY = 10

/**
 * The popularity line, as a proportion of the average item's share.
 *
 * The textbook uses 70% of the average, on the reasoning that expecting every
 * dish to be above average is asking half the menu to be below it. Kept as
 * published rather than tuned, so the classification means what a restaurant
 * consultant would expect it to mean.
 */
export const POPULARITY_FACTOR = 0.7

function median(values: readonly number[]): number {
  if (values.length === 0) return 0

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle]
}

/**
 * Classifies a menu.
 *
 * The contribution line is the MEDIAN unit contribution, not the mean. One
 * expensive steak drags a mean upward far enough to reclassify half the menu
 * as unprofitable, and the resulting advice — "remove these fourteen dishes" —
 * is exactly the sort of confident nonsense that stops anyone reading the
 * recommendations again.
 */
export function classifyMenu(
  performance: readonly MenuItemPerformance[],
): MenuAnalysis {
  const excluded: MenuAnalysis['excluded'] = []
  const eligible: MenuItemPerformance[] = []

  for (const item of performance) {
    if (!item.isCosted) {
      excluded.push({ name: item.name, reason: 'no_recipe' })
      continue
    }
    if (item.quantity < MIN_SALES_TO_CLASSIFY) {
      excluded.push({ name: item.name, reason: 'too_few_sales' })
      continue
    }
    eligible.push(item)
  }

  if (eligible.length === 0) {
    return {
      items: [],
      excluded,
      contributionThresholdMinor: 0,
      popularityThresholdBasisPoints: 0,
    }
  }

  const totalUnits = eligible.reduce((sum, item) => sum + item.quantity, 0)

  const unitContributions = eligible.map((item) =>
    Math.round((item.revenueMinor - item.costMinor) / item.quantity),
  )
  const contributionThresholdMinor = median(unitContributions)

  /**
   * The average item's share is 1/n of the units. An item is popular if it
   * clears 70% of that — the published rule, kept as published.
   */
  const popularityThresholdBasisPoints = Math.round(
    (10_000 / eligible.length) * POPULARITY_FACTOR,
  )

  const items: ClassifiedItem[] = eligible.map((item) => {
    const contributionMinor = item.revenueMinor - item.costMinor
    const unitContributionMinor = Math.round(contributionMinor / item.quantity)
    const popularityBasisPoints =
      totalUnits === 0
        ? 0
        : Math.round((item.quantity * 10_000) / totalUnits)

    const popular = popularityBasisPoints >= popularityThresholdBasisPoints
    const profitable = unitContributionMinor >= contributionThresholdMinor

    const quadrant: MenuQuadrant = popular
      ? profitable
        ? 'star'
        : 'plowhorse'
      : profitable
        ? 'puzzle'
        : 'dog'

    return {
      ...item,
      quadrant,
      contributionMinor,
      unitContributionMinor,
      marginBasisPoints:
        item.revenueMinor === 0
          ? null
          : Math.round((contributionMinor * 10_000) / item.revenueMinor),
      popularityBasisPoints,
    }
  })

  return {
    items: items.sort((a, b) => b.contributionMinor - a.contributionMinor),
    excluded,
    contributionThresholdMinor,
    popularityThresholdBasisPoints,
  }
}

/** What each quadrant means, in the words a manager would use. */
export const QUADRANT_MEANING: Record<MenuQuadrant, string> = {
  star: 'Sells well and earns well. Protect its recipe, its price and its place on the menu.',
  plowhorse:
    'Sells well but earns little. The kitchen is working hard for it — reprice it, re-cost it, or shrink the portion.',
  puzzle:
    'Earns well but nobody orders it. Move it up the menu, describe it better, or let staff recommend it.',
  dog: 'Neither sells nor earns. It occupies a line on the menu and a space in the walk-in.',
}
