import { describe, expect, it } from 'vitest'

import {
  generateInsights,
  MIN_BILLS_FOR_ADVICE,
  sortInsights,
  type AdvisorSnapshot,
  type Insight,
} from './insights'

/** A quiet, healthy restaurant. Every rule below is off unless switched on. */
function snapshot(overrides: Partial<AdvisorSnapshot> = {}): AdvisorSnapshot {
  return {
    periodDays: 7,
    sales: {
      bills: 200,
      covers: 500,
      netSalesMinor: 1_000_000,
      costMinor: 300_000,
      discountMinor: 10_000,
      grossProfitMinor: 700_000,
      marginBasisPoints: 7_000,
      costCoverageBasisPoints: 10_000,
      previousBills: 200,
      previousNetSalesMinor: 1_000_000,
      previousDiscountMinor: 10_000,
      billsWithCustomer: 100,
      ...overrides.sales,
    },
    menu: [],
    previousMenuQuantities: {},
    stock: [],
    wastage: [],
    costDrift: [],
    stations: [],
    voids: [],
    atRiskCustomers: [],
    pointsOutstanding: 0,
    pointsEarnedThisPeriod: 1_000,
    activeCustomers: 50,
    targetFoodCostBasisPoints: 3_500,
    cashShareBasisPoints: 2_000,
    ...overrides,
  }
}

function keys(insights: readonly Insight[]): string[] {
  return insights.map((insight) => insight.key)
}

describe('refusing to advise', () => {
  it('says so plainly when there is too little trade', () => {
    const result = generateInsights(
      snapshot({
        sales: {
          ...snapshot().sales,
          bills: MIN_BILLS_FOR_ADVICE - 1,
          // A discount rate that has tripled — and still not worth saying.
          discountMinor: 300_000,
          previousDiscountMinor: 10_000,
        },
      }),
    )

    expect(result.refusal).toMatch(/too few/i)
    expect(keys(result.insights)).not.toContain('finance:discount-creep')
  })

  it('still reports a counting error on a quiet week', () => {
    /**
     * A negative stock level is true whatever the trade was, and a new
     * restaurant is exactly where a receiving mistake is most likely.
     */
    const result = generateInsights(
      snapshot({
        sales: { ...snapshot().sales, bills: 3 },
        stock: [
          {
            ingredientId: 'i1',
            name: 'Noodles',
            unit: 'kg',
            onHandMilli: -4_000,
            reorderPointMilli: 0,
            reorderQuantityMilli: 0,
            supplierName: null,
            neverCounted: false,
          },
        ],
      }),
    )

    expect(result.refusal).not.toBeNull()
    expect(keys(result.insights)).toContain('inventory:negative')
  })

  it('offers nothing at all when a healthy restaurant is running well', () => {
    const result = generateInsights(snapshot())

    expect(result.refusal).toBeNull()
    // Silence is a valid answer, and the most common one for a business with
    // nothing wrong with it.
    expect(result.insights).toEqual([])
  })
})

describe('menu findings', () => {
  /**
   * Four items, not three. The contribution line is the MEDIAN unit
   * contribution, so with an odd number of dishes the middle one sits exactly
   * on the line and counts as profitable — there is no plowhorse to find.
   */
  const menu = [
    // Popular and profitable: 1,100 a portion.
    {
      menuItemId: 'laksa',
      name: 'Laksa',
      categoryName: null,
      quantity: 200,
      revenueMinor: 300_000,
      costMinor: 80_000,
      isCosted: true,
    },
    // Just as popular, 200 a portion.
    {
      menuItemId: 'rice',
      name: 'Rice',
      categoryName: null,
      quantity: 200,
      revenueMinor: 160_000,
      costMinor: 120_000,
      isCosted: true,
    },
    // Best margin on the menu, barely ordered: 4,000 a portion.
    {
      menuItemId: 'steak',
      name: 'Steak',
      categoryName: null,
      quantity: 20,
      revenueMinor: 120_000,
      costMinor: 40_000,
      isCosted: true,
    },
    // Neither: 200 a portion, 20 sold.
    {
      menuItemId: 'salad',
      name: 'Salad',
      categoryName: null,
      quantity: 20,
      revenueMinor: 18_000,
      costMinor: 14_000,
      isCosted: true,
    },
  ]

  it('flags the plowhorse and the dog but leaves the star alone', () => {
    const result = generateInsights(snapshot({ menu }))

    expect(keys(result.insights)).toContain('menu:plowhorse:rice')
    expect(keys(result.insights)).toContain('menu:dog:salad')
    expect(keys(result.insights)).toContain('menu:puzzle:steak')
    // Nothing to say about a dish that sells well and earns well.
    expect(keys(result.insights)).not.toContain('menu:star:laksa')
  })

  it('warns that margin covers only part of the menu', () => {
    const result = generateInsights(
      snapshot({
        menu: [
          ...menu,
          {
            menuItemId: 'wine',
            name: 'Wine',
            categoryName: null,
            quantity: 100,
            revenueMinor: 400_000,
            costMinor: 0,
            isCosted: false,
          },
        ],
        sales: { ...snapshot().sales, costCoverageBasisPoints: 5_000 },
      }),
    )

    const coverage = result.insights.find((i) => i.key === 'menu:coverage')

    expect(coverage).toBeDefined()
    expect(coverage!.severity).toBe('warning')
    // It names the item to fix, rather than saying "some items".
    expect(coverage!.recommendation).toContain('Wine')
  })

  it('says nothing about coverage when the menu is fully costed', () => {
    const result = generateInsights(snapshot({ menu }))
    expect(keys(result.insights)).not.toContain('menu:coverage')
  })

  it('notices a dish that has fallen away', () => {
    const result = generateInsights(
      snapshot({
        menu,
        previousMenuQuantities: { Laksa: 400, Rice: 200, Steak: 20, Salad: 20 },
      }),
    )

    const decline = result.insights.find(
      (i) => i.key === 'menu:declining:laksa',
    )
    expect(decline).toBeDefined()
    expect(decline!.finding).toContain('400')
  })

  it('ignores a fall in something that barely sold before', () => {
    const result = generateInsights(
      snapshot({
        menu,
        // Three portions down to none is noise, not a trend.
        previousMenuQuantities: { Salad: 3 },
      }),
    )

    expect(keys(result.insights)).not.toContain('menu:declining:salad')
  })
})

describe('inventory findings', () => {
  const ingredient = {
    ingredientId: 'i1',
    name: 'Noodles',
    unit: 'kg',
  }

  it('names the supplier when one is set, and asks for one when not', () => {
    const withSupplier = generateInsights(
      snapshot({
        stock: [
          {
            ...ingredient,
            onHandMilli: 1_000,
            reorderPointMilli: 2_000,
            reorderQuantityMilli: 20_000,
            supplierName: 'Kedai Basah',
            neverCounted: false,
          },
        ],
      }),
    )

    expect(
      withSupplier.insights.find((i) => i.key === 'inventory:reorder:i1')!
        .recommendation,
    ).toContain('Kedai Basah')

    const without = generateInsights(
      snapshot({
        stock: [
          {
            ...ingredient,
            onHandMilli: 1_000,
            reorderPointMilli: 2_000,
            reorderQuantityMilli: 20_000,
            supplierName: null,
            neverCounted: false,
          },
        ],
      }),
    )

    expect(
      without.insights.find((i) => i.key === 'inventory:reorder:i1')!
        .recommendation,
    ).toContain('preferred supplier')
  })

  it('does not ask to reorder an ingredient with no reorder point', () => {
    // Zero means "not tracked", not "order immediately".
    const result = generateInsights(
      snapshot({
        stock: [
          {
            ...ingredient,
            onHandMilli: 0,
            reorderPointMilli: 0,
            reorderQuantityMilli: 0,
            supplierName: null,
            neverCounted: false,
          },
        ],
      }),
    )

    expect(keys(result.insights)).not.toContain('inventory:reorder:i1')
  })

  it('treats a negative level as an error, not a shortage', () => {
    const result = generateInsights(
      snapshot({
        stock: [
          {
            ...ingredient,
            onHandMilli: -500,
            reorderPointMilli: 2_000,
            reorderQuantityMilli: 20_000,
            supplierName: 'Kedai Basah',
            neverCounted: false,
          },
        ],
      }),
    )

    const negative = result.insights.find(
      (i) => i.key === 'inventory:negative',
    )
    expect(negative!.severity).toBe('critical')
    // Not also a reorder nag: the number it would reorder against is wrong.
    expect(keys(result.insights)).not.toContain('inventory:reorder:i1')
  })

  it('flags wastage above a twentieth of what was cooked', () => {
    const result = generateInsights(
      snapshot({
        wastage: [
          {
            ...ingredient,
            wastedMilli: 6_000,
            consumedMilli: 100_000,
            wastedValueMinor: 3_000,
          },
        ],
      }),
    )

    expect(keys(result.insights)).toContain('inventory:wastage:i1')
  })

  it('ignores wastage against nothing consumed', () => {
    // A write-off with no cooking behind it gives a share of infinity.
    const result = generateInsights(
      snapshot({
        wastage: [
          {
            ...ingredient,
            wastedMilli: 6_000,
            consumedMilli: 0,
            wastedValueMinor: 3_000,
          },
        ],
      }),
    )

    expect(keys(result.insights)).not.toContain('inventory:wastage:i1')
  })

  it('connects a cost rise to the dishes it thins', () => {
    const result = generateInsights(
      snapshot({
        costDrift: [
          {
            ...ingredient,
            previousCostPerUnitMinor: 500,
            currentCostPerUnitMinor: 700,
            affectedItems: ['Laksa', 'Mee Goreng'],
          },
        ],
      }),
    )

    const drift = result.insights.find(
      (i) => i.key === 'inventory:cost-drift:i1',
    )
    expect(drift).toBeDefined()
    // The point of the rule: nobody changed a price, but the margin moved.
    expect(drift!.recommendation).toContain('Laksa')
    expect(drift!.recommendation).toContain('without anyone changing a price')
  })

  it('says nothing about a cost that barely moved', () => {
    const result = generateInsights(
      snapshot({
        costDrift: [
          {
            ...ingredient,
            previousCostPerUnitMinor: 500,
            currentCostPerUnitMinor: 520,
            affectedItems: ['Laksa'],
          },
        ],
      }),
    )

    expect(keys(result.insights)).not.toContain('inventory:cost-drift:i1')
  })
})

describe('operations findings', () => {
  it('judges a station against the others, not against a fixed time', () => {
    const result = generateInsights(
      snapshot({
        stations: [
          { stationId: 's1', name: 'Grill', tickets: 100, medianPrepMinutes: 18 },
          { stationId: 's2', name: 'Wok', tickets: 100, medianPrepMinutes: 6 },
          { stationId: 's3', name: 'Cold', tickets: 100, medianPrepMinutes: 4 },
        ],
      }),
    )

    expect(keys(result.insights)).toContain('operations:slow-station:s1')
    expect(keys(result.insights)).not.toContain('operations:slow-station:s2')
  })

  it('will not call a station slow when it is the only one measured', () => {
    const result = generateInsights(
      snapshot({
        stations: [
          { stationId: 's1', name: 'Grill', tickets: 100, medianPrepMinutes: 40 },
          { stationId: 's2', name: 'Wok', tickets: 2, medianPrepMinutes: 5 },
        ],
      }),
    )

    // One station is not a comparison, however slow it looks.
    expect(result.insights.filter((i) => i.domain === 'operations')).toEqual([])
  })

  it('raises concentrated voids as a question, not an accusation', () => {
    const result = generateInsights(
      snapshot({
        voids: [
          { userId: 'u1', name: 'Ana', count: 12, valueMinor: 40_000 },
          { userId: 'u2', name: 'Ben', count: 2, valueMinor: 3_000 },
        ],
      }),
    )

    const voids = result.insights.find((i) => i.key === 'operations:voids:u1')
    expect(voids).toBeDefined()
    expect(voids!.severity).toBe('info')
    // Whoever works the till most will always top this list.
    expect(voids!.recommendation).toMatch(/rather than an alarm/i)
  })

  it('says nothing when only one person voided anything', () => {
    const result = generateInsights(
      snapshot({
        voids: [{ userId: 'u1', name: 'Ana', count: 12, valueMinor: 40_000 }],
      }),
    )

    // 100% of voids by the only person who voided is not a finding.
    expect(keys(result.insights)).not.toContain('operations:voids:u1')
  })
})

describe('customer findings', () => {
  it('notices that members are not being attached at the till', () => {
    const result = generateInsights(
      snapshot({
        sales: { ...snapshot().sales, billsWithCustomer: 4 },
      }),
    )

    expect(keys(result.insights)).toContain('customers:capture')
  })

  it('says nothing about capture when there are no members to capture', () => {
    const result = generateInsights(
      snapshot({
        activeCustomers: 0,
        sales: { ...snapshot().sales, billsWithCustomer: 0 },
      }),
    )

    expect(keys(result.insights)).not.toContain('customers:capture')
  })

  it('reports a lapsing regular, and how thin the evidence is', () => {
    const result = generateInsights(
      snapshot({
        atRiskCustomers: [
          {
            customerId: 'c1',
            name: 'Siti',
            daysSinceVisit: 60,
            typicalGapDays: 7,
            visits: 2,
            lifetimeSpendMinor: 40_000,
          },
        ],
      }),
    )

    const risk = result.insights.find((i) => i.key === 'customers:at-risk:c1')
    expect(risk).toBeDefined()
    // Two visits is not a rhythm, and the confidence says so.
    expect(risk!.confidence).toBe('low')
  })

  it('notices points going in and not coming out', () => {
    const result = generateInsights(
      snapshot({ pointsOutstanding: 5_000, pointsEarnedThisPeriod: 1_000 }),
    )

    const overhang = result.insights.find(
      (i) => i.key === 'customers:points-overhang',
    )
    expect(overhang).toBeDefined()
    expect(overhang!.evidence.map((e) => e.value.kind)).not.toContain('money')
  })

  it('refuses to put a currency figure on the points liability', () => {
    const result = generateInsights(
      snapshot({ pointsOutstanding: 5_000, pointsEarnedThisPeriod: 1_000 }),
    )
    const overhang = result.insights.find(
      (i) => i.key === 'customers:points-overhang',
    )!

    /**
     * Nothing in the system records what a point is worth — redemption is in
     * points, and what those buy is decided outside it. Stating a money value
     * would mean inventing a rate and reporting it as if it were measured.
     */
    expect(overhang.recommendation).toContain('cannot be valued in money')
    expect(overhang.evidence).toContainEqual({
      label: 'Redemption rate on file',
      value: { kind: 'text', value: 'none — points are redeemed as points' },
    })
  })

  it('says nothing when points are being spent as fast as they are earned', () => {
    const result = generateInsights(
      snapshot({ pointsOutstanding: 900, pointsEarnedThisPeriod: 1_000 }),
    )
    expect(keys(result.insights)).not.toContain('customers:points-overhang')
  })
})

describe('finance findings', () => {
  it('notices discounts taking a bigger share', () => {
    const result = generateInsights(
      snapshot({
        sales: {
          ...snapshot().sales,
          discountMinor: 60_000,
          previousDiscountMinor: 10_000,
        },
      }),
    )

    expect(keys(result.insights)).toContain('finance:discount-creep')
  })

  it('refuses to state food cost against a target on a half-costed menu', () => {
    const result = generateInsights(
      snapshot({
        sales: {
          ...snapshot().sales,
          costMinor: 500_000,
          costCoverageBasisPoints: 4_000,
        },
      }),
    )

    /**
     * A food cost percentage of an unknown fraction of the business is a
     * number somebody would act on, and it does not mean what it says.
     */
    expect(keys(result.insights)).not.toContain('finance:food-cost')
    expect(keys(result.insights)).toContain('menu:coverage')
  })

  it('states food cost once the menu is costed', () => {
    const result = generateInsights(
      snapshot({
        sales: { ...snapshot().sales, costMinor: 500_000 },
      }),
    )

    const foodCost = result.insights.find((i) => i.key === 'finance:food-cost')
    expect(foodCost).toBeDefined()
    expect(foodCost!.evidence.map((e) => e.label)).toContain('Recipe coverage')
  })

  it('says nothing when food cost is at target', () => {
    const result = generateInsights(snapshot())
    expect(keys(result.insights)).not.toContain('finance:food-cost')
  })
})

describe('ranking', () => {
  it('puts the most severe first and the best-evidenced first within that', () => {
    const sorted = sortInsights([
      {
        key: 'b',
        domain: 'sales',
        severity: 'warning',
        title: '',
        finding: '',
        recommendation: '',
        evidence: [],
        confidence: 'high',
        basis: '',
      },
      {
        key: 'a',
        domain: 'sales',
        severity: 'warning',
        title: '',
        finding: '',
        recommendation: '',
        evidence: [],
        confidence: 'low',
        basis: '',
      },
      {
        key: 'c',
        domain: 'inventory',
        severity: 'critical',
        title: '',
        finding: '',
        recommendation: '',
        evidence: [],
        confidence: 'low',
        basis: '',
      },
    ])

    // Severity first; then the better-evidenced warning above the thin one,
    // rather than alphabetically.
    expect(keys(sorted)).toEqual(['c', 'b', 'a'])
  })
})

describe('every insight is answerable', () => {
  it('carries evidence, a recommendation and a stated basis', () => {
    const result = generateInsights(
      snapshot({
        menu: [
          {
            menuItemId: 'salad',
            name: 'Salad',
            categoryName: null,
            quantity: 20,
            revenueMinor: 18_000,
            costMinor: 14_000,
            isCosted: true,
          },
          {
            menuItemId: 'laksa',
            name: 'Laksa',
            categoryName: null,
            quantity: 200,
            revenueMinor: 300_000,
            costMinor: 80_000,
            isCosted: true,
          },
        ],
        stock: [
          {
            ingredientId: 'i1',
            name: 'Noodles',
            unit: 'kg',
            onHandMilli: -500,
            reorderPointMilli: 1_000,
            reorderQuantityMilli: 10_000,
            supplierName: null,
            neverCounted: true,
          },
        ],
        sales: {
          ...snapshot().sales,
          discountMinor: 60_000,
          previousDiscountMinor: 10_000,
        },
      }),
    )

    expect(result.insights.length).toBeGreaterThan(3)

    /**
     * The contract that makes the advisor trustworthy: nothing is asserted
     * without the figures it came from and a statement of how much they can
     * bear. A finding with no evidence is a guess with a confident tone.
     */
    for (const insight of result.insights) {
      expect(insight.evidence.length).toBeGreaterThan(0)
      expect(insight.recommendation.length).toBeGreaterThan(0)
      expect(insight.basis.length).toBeGreaterThan(0)
      expect(insight.finding).not.toBe(insight.recommendation)
    }
  })

  it('gives every insight a key that does not move with the numbers', () => {
    const quiet = generateInsights(
      snapshot({
        wastage: [
          {
            ingredientId: 'i1',
            name: 'Noodles',
            unit: 'kg',
            wastedMilli: 6_000,
            consumedMilli: 100_000,
            wastedValueMinor: 3_000,
          },
        ],
      }),
    )

    const worse = generateInsights(
      snapshot({
        wastage: [
          {
            ingredientId: 'i1',
            name: 'Noodles',
            unit: 'kg',
            wastedMilli: 30_000,
            consumedMilli: 100_000,
            wastedValueMinor: 15_000,
          },
        ],
      }),
    )

    /**
     * A dismissal is stored against the key. A key that moved with the figures
     * would resurrect every dismissed recommendation the moment anything
     * changed — which is exactly when it is least welcome and most repeated.
     */
    expect(keys(quiet.insights)).toEqual(keys(worse.insights))
  })
})
