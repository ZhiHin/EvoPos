import { describe, expect, it } from 'vitest'

import {
  costOf,
  explodeRequirements,
  findShortfalls,
  formatQuantity,
  stockStatus,
  suggestReorders,
  weightedAverageCost,
  type RecipeBook,
} from './stock'

function recipes(
  byMenuItem: Record<string, [string, number][]> = {},
  byModifierOption: Record<string, [string, number][]> = {},
): RecipeBook {
  const toComponents = (entries: [string, number][]) =>
    entries.map(([ingredientId, quantityMilli]) => ({
      ingredientId,
      quantityMilli,
    }))

  return {
    byMenuItem: new Map(
      Object.entries(byMenuItem).map(([k, v]) => [k, toComponents(v)]),
    ),
    byModifierOption: new Map(
      Object.entries(byModifierOption).map(([k, v]) => [k, toComponents(v)]),
    ),
  }
}

describe('explodeRequirements', () => {
  it('multiplies a recipe by the quantity ordered', () => {
    const result = explodeRequirements(
      [{ menuItemId: 'burger', quantity: 3, modifierOptionIds: [] }],
      recipes({ burger: [['beef', 150], ['bun', 1000]] }),
    )

    expect(result).toEqual([
      { ingredientId: 'beef', quantityMilli: 450 },
      { ingredientId: 'bun', quantityMilli: 3000 },
    ])
  })

  it('adds modifier recipes on top of the item', () => {
    const result = explodeRequirements(
      [{ menuItemId: 'burger', quantity: 2, modifierOptionIds: ['extraCheese'] }],
      recipes(
        { burger: [['beef', 150]] },
        { extraCheese: [['cheese', 20]] },
      ),
    )

    // Two burgers, each with extra cheese: 40 g of cheese genuinely left the
    // fridge. Ignoring modifiers is how counts drift by exactly the upsells.
    expect(result).toEqual([
      { ingredientId: 'beef', quantityMilli: 300 },
      { ingredientId: 'cheese', quantityMilli: 40 },
    ])
  })

  it('merges an ingredient used by both the item and a modifier', () => {
    const result = explodeRequirements(
      [{ menuItemId: 'pasta', quantity: 1, modifierOptionIds: ['extraButter'] }],
      recipes({ pasta: [['butter', 10]] }, { extraButter: [['butter', 15]] }),
    )

    expect(result).toEqual([{ ingredientId: 'butter', quantityMilli: 25 }])
  })

  it('returns requirements sorted by ingredient id', () => {
    const result = explodeRequirements(
      [{ menuItemId: 'dish', quantity: 1, modifierOptionIds: [] }],
      recipes({ dish: [['zucchini', 1], ['apple', 1], ['mint', 1]] }),
    )

    // Deterministic order means two concurrent orders lock the same rows in
    // the same sequence and cannot deadlock against each other.
    expect(result.map((r) => r.ingredientId)).toEqual([
      'apple',
      'mint',
      'zucchini',
    ])
  })

  it('ignores an item with no recipe', () => {
    const result = explodeRequirements(
      [{ menuItemId: 'bottledWater', quantity: 5, modifierOptionIds: [] }],
      recipes(),
    )

    expect(result).toEqual([])
  })

  it('ignores zero and negative quantities', () => {
    expect(
      explodeRequirements(
        [{ menuItemId: 'burger', quantity: 0, modifierOptionIds: [] }],
        recipes({ burger: [['beef', 150]] }),
      ),
    ).toEqual([])

    expect(
      explodeRequirements(
        [{ menuItemId: 'burger', quantity: 1, modifierOptionIds: [] }],
        recipes({ burger: [['beef', -150]] }),
      ),
    ).toEqual([])
  })

  it('accumulates across separate lines of the same item', () => {
    const result = explodeRequirements(
      [
        { menuItemId: 'burger', quantity: 1, modifierOptionIds: [] },
        { menuItemId: 'burger', quantity: 2, modifierOptionIds: [] },
      ],
      recipes({ burger: [['beef', 150]] }),
    )

    expect(result).toEqual([{ ingredientId: 'beef', quantityMilli: 450 }])
  })
})

describe('findShortfalls', () => {
  it('reports an ingredient with less on hand than required', () => {
    const result = findShortfalls(
      [{ ingredientId: 'beef', quantityMilli: 500 }],
      [{ ingredientId: 'beef', quantityMilli: 300 }],
    )

    expect(result).toEqual([
      { ingredientId: 'beef', requiredMilli: 500, availableMilli: 300 },
    ])
  })

  it('treats an ingredient with no stock row as zero on hand', () => {
    const result = findShortfalls(
      [{ ingredientId: 'saffron', quantityMilli: 1 }],
      [],
    )

    expect(result).toEqual([
      { ingredientId: 'saffron', requiredMilli: 1, availableMilli: 0 },
    ])
  })

  it('does not report an exact match as short', () => {
    expect(
      findShortfalls(
        [{ ingredientId: 'beef', quantityMilli: 300 }],
        [{ ingredientId: 'beef', quantityMilli: 300 }],
      ),
    ).toEqual([])
  })

  it('reports only the ingredients that are actually short', () => {
    const result = findShortfalls(
      [
        { ingredientId: 'beef', quantityMilli: 500 },
        { ingredientId: 'bun', quantityMilli: 1000 },
      ],
      [
        { ingredientId: 'beef', quantityMilli: 300 },
        { ingredientId: 'bun', quantityMilli: 9000 },
      ],
    )

    expect(result.map((s) => s.ingredientId)).toEqual(['beef'])
  })
})

describe('costOf', () => {
  it('costs a partial unit against the per-unit price', () => {
    // 250 g of a RM 12.00/kg ingredient is RM 3.00.
    expect(costOf(250, 1200)).toBe(300)
  })

  it('costs a whole unit as exactly the unit price', () => {
    expect(costOf(1000, 1200)).toBe(1200)
  })

  it('rounds to the nearest minor unit', () => {
    // 1 g of a RM 12.00/kg ingredient is 1.2 sen, which cannot be charged.
    expect(costOf(1, 1200)).toBe(1)
    expect(costOf(1, 1600)).toBe(2)
  })

  it('costs nothing at zero quantity', () => {
    expect(costOf(0, 1200)).toBe(0)
  })
})

describe('weightedAverageCost', () => {
  it('takes the received cost when there was no stock', () => {
    expect(
      weightedAverageCost({
        onHandMilli: 0,
        currentCostPerUnitMinor: 0,
        receivedMilli: 5000,
        receivedCostPerUnitMinor: 1200,
      }),
    ).toBe(1200)
  })

  it('blends by quantity, not by a plain average of the two prices', () => {
    // 1 kg at RM 10 plus 3 kg at RM 14 is RM 13/kg, not RM 12.
    expect(
      weightedAverageCost({
        onHandMilli: 1000,
        currentCostPerUnitMinor: 1000,
        receivedMilli: 3000,
        receivedCostPerUnitMinor: 1400,
      }),
    ).toBe(1300)
  })

  it('keeps the current cost when nothing was received', () => {
    expect(
      weightedAverageCost({
        onHandMilli: 1000,
        currentCostPerUnitMinor: 1000,
        receivedMilli: 0,
        receivedCostPerUnitMinor: 9999,
      }),
    ).toBe(1000)
  })

  it('ignores negative stock when weighting', () => {
    /**
     * A negative balance means deduction outran receiving — a counting error,
     * not a valuation. Letting it weight the average would drag the cost away
     * from what was just paid, and by an arbitrary amount.
     */
    expect(
      weightedAverageCost({
        onHandMilli: -2000,
        currentCostPerUnitMinor: 500,
        receivedMilli: 1000,
        receivedCostPerUnitMinor: 1400,
      }),
    ).toBe(1400)
  })

  it('rounds the blended cost to a whole minor unit', () => {
    expect(
      weightedAverageCost({
        onHandMilli: 1000,
        currentCostPerUnitMinor: 1000,
        receivedMilli: 1000,
        receivedCostPerUnitMinor: 1001,
      }),
    ).toBe(1001)
  })
})

describe('stockStatus', () => {
  it('reports out at zero', () => {
    expect(stockStatus(0, 500)).toBe('out')
  })

  it('reports out when negative', () => {
    expect(stockStatus(-100, 500)).toBe('out')
  })

  it('reports low at the reorder point', () => {
    expect(stockStatus(500, 500)).toBe('low')
  })

  it('reports ok above the reorder point', () => {
    expect(stockStatus(501, 500)).toBe('ok')
  })

  it('never reports low when no reorder point is set', () => {
    expect(stockStatus(1, 0)).toBe('ok')
  })
})

describe('suggestReorders', () => {
  it('tops up to the reorder point plus the order quantity', () => {
    const result = suggestReorders([
      {
        ingredientId: 'beef',
        quantityMilli: 400,
        reorderPointMilli: 1000,
        reorderQuantityMilli: 5000,
      },
    ])

    expect(result).toEqual([
      { ingredientId: 'beef', suggestedMilli: 5600, status: 'low' },
    ])
  })

  it('orders the full top-up when nothing is left', () => {
    const result = suggestReorders([
      {
        ingredientId: 'beef',
        quantityMilli: 0,
        reorderPointMilli: 1000,
        reorderQuantityMilli: 5000,
      },
    ])

    // A flat order quantity would under-serve this against an ingredient
    // merely dipping below its point.
    expect(result[0].suggestedMilli).toBe(6000)
  })

  it('omits ingredients that are comfortably stocked', () => {
    expect(
      suggestReorders([
        {
          ingredientId: 'beef',
          quantityMilli: 9000,
          reorderPointMilli: 1000,
          reorderQuantityMilli: 5000,
        },
      ]),
    ).toEqual([])
  })

  it('puts out-of-stock ingredients first', () => {
    const result = suggestReorders([
      {
        ingredientId: 'aaa-low',
        quantityMilli: 900,
        reorderPointMilli: 1000,
        reorderQuantityMilli: 5000,
      },
      {
        ingredientId: 'zzz-out',
        quantityMilli: 0,
        reorderPointMilli: 1000,
        reorderQuantityMilli: 5000,
      },
    ])

    // Sorted ahead of an alphabetically earlier ingredient: being out is
    // already costing sales, being low is not yet.
    expect(result.map((s) => s.ingredientId)).toEqual(['zzz-out', 'aaa-low'])
  })

  it('does not suggest an order for negative stock it cannot cover', () => {
    // Negative on hand is floored, so the suggestion refills to the target
    // rather than ordering extra to cover a counting error.
    const result = suggestReorders([
      {
        ingredientId: 'beef',
        quantityMilli: -3000,
        reorderPointMilli: 1000,
        reorderQuantityMilli: 5000,
      },
    ])

    expect(result[0].suggestedMilli).toBe(6000)
  })
})

describe('formatQuantity', () => {
  it('formats whole pieces without decimals', () => {
    expect(formatQuantity(3000, 'each')).toBe('3 pieces')
    expect(formatQuantity(1000, 'each')).toBe('1 piece')
  })

  it('formats weights with the unit', () => {
    expect(formatQuantity(1250, 'kg')).toBe('1.25 kg')
    expect(formatQuantity(2000, 'kg')).toBe('2 kg')
  })

  it('formats volumes', () => {
    expect(formatQuantity(500, 'l')).toBe('0.5 l')
  })
})
