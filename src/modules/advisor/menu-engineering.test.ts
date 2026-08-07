import { describe, expect, it } from 'vitest'

import {
  classifyMenu,
  MIN_SALES_TO_CLASSIFY,
  type MenuItemPerformance,
} from './menu-engineering'

function item(
  name: string,
  quantity: number,
  unitPriceMinor: number,
  unitCostMinor: number,
  isCosted = true,
): MenuItemPerformance {
  return {
    menuItemId: `id-${name}`,
    name,
    categoryName: null,
    quantity,
    revenueMinor: quantity * unitPriceMinor,
    costMinor: quantity * unitCostMinor,
    isCosted,
  }
}

describe('menu engineering', () => {
  it('places a popular, profitable dish in the star quadrant', () => {
    const analysis = classifyMenu([
      item('Laksa', 200, 1_500, 400),
      item('Rice', 200, 800, 600),
      item('Steak', 20, 6_000, 2_000),
      item('Salad', 20, 900, 700),
    ])

    const byName = new Map(analysis.items.map((i) => [i.name, i.quadrant]))

    expect(byName.get('Laksa')).toBe('star')
    // Sells as well as the laksa and returns 200 a portion against 1100.
    expect(byName.get('Rice')).toBe('plowhorse')
    // Best margin on the menu, barely ordered.
    expect(byName.get('Steak')).toBe('puzzle')
    expect(byName.get('Salad')).toBe('dog')
  })

  it('uses the median unit contribution, not the mean', () => {
    /**
     * One expensive dish drags a mean upward far enough to reclassify most of
     * the menu as unprofitable — and "remove these four dishes" is exactly the
     * confident nonsense that stops anyone reading the advice again.
     */
    const analysis = classifyMenu([
      item('Cheap A', 100, 1_000, 700),
      item('Cheap B', 100, 1_000, 700),
      item('Cheap C', 100, 1_000, 700),
      item('Lobster', 100, 20_000, 5_000),
    ])

    // Median unit contribution is 300, not the 4,050 a mean would give.
    expect(analysis.contributionThresholdMinor).toBe(300)
    expect(
      analysis.items.filter((i) => i.quadrant === 'dog'),
    ).toHaveLength(0)
  })

  it('refuses to classify a dish that has barely sold', () => {
    const analysis = classifyMenu([
      item('Laksa', 200, 1_500, 400),
      item('Special', MIN_SALES_TO_CLASSIFY - 1, 2_000, 300),
    ])

    // Not unpopular. Unmeasured.
    expect(analysis.items.map((i) => i.name)).toEqual(['Laksa'])
    expect(analysis.excluded).toContainEqual({
      name: 'Special',
      reason: 'too_few_sales',
    })
  })

  it('refuses to classify a dish with no recipe', () => {
    const analysis = classifyMenu([
      item('Laksa', 100, 1_500, 400),
      item('Wine', 100, 4_000, 0, false),
    ])

    /**
     * A cost of zero would give the wine the best contribution on the menu and
     * recommend featuring it. Excluding it is the only honest option.
     */
    expect(analysis.items.map((i) => i.name)).toEqual(['Laksa'])
    expect(analysis.excluded).toContainEqual({
      name: 'Wine',
      reason: 'no_recipe',
    })
  })

  it('names what it left out rather than dropping it silently', () => {
    const analysis = classifyMenu([
      item('Wine', 100, 4_000, 0, false),
      item('Special', 2, 2_000, 300),
    ])

    expect(analysis.items).toHaveLength(0)
    expect(analysis.excluded).toHaveLength(2)
  })

  it('returns nothing at all from an empty menu, without dividing by zero', () => {
    const analysis = classifyMenu([])

    expect(analysis.items).toEqual([])
    expect(analysis.contributionThresholdMinor).toBe(0)
    expect(analysis.popularityThresholdBasisPoints).toBe(0)
  })

  it('sets the popularity line at 70% of an even share', () => {
    const analysis = classifyMenu([
      item('A', 100, 1_000, 500),
      item('B', 100, 1_000, 500),
      item('C', 100, 1_000, 500),
      item('D', 100, 1_000, 500),
    ])

    // Four items, so an even share is 25%; the line sits at 17.5%.
    expect(analysis.popularityThresholdBasisPoints).toBe(1_750)
    expect(analysis.items.every((i) => i.popularityBasisPoints === 2_500)).toBe(
      true,
    )
  })

  it('reports contribution and margin per item', () => {
    const [laksa] = classifyMenu([
      item('Laksa', 100, 1_500, 400),
      item('Rice', 100, 800, 600),
    ]).items

    expect(laksa.contributionMinor).toBe(110_000)
    expect(laksa.unitContributionMinor).toBe(1_100)
    // 1100 / 1500
    expect(laksa.marginBasisPoints).toBe(7_333)
  })

  it('ranks by total contribution, not by margin', () => {
    /**
     * A 90% margin on four portions earns less than a 30% margin on four
     * hundred, and a list ordered by margin puts the wrong dish at the top.
     */
    const analysis = classifyMenu([
      item('Coffee', 400, 500, 350),
      item('Tasting menu', 20, 20_000, 2_000),
    ])

    expect(analysis.items[0].name).toBe('Tasting menu')
    expect(analysis.items[0].contributionMinor).toBe(360_000)
    expect(analysis.items[1].contributionMinor).toBe(60_000)
  })
})
