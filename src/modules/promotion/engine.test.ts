import { describe, expect, it } from 'vitest'

import {
  calculatePromotionDiscount,
  checkEligibility,
  evaluatePromotions,
  isWithinTimeWindow,
  scopedLines,
  type BillContext,
  type BillLineContext,
  type PromotionConditions,
  type PromotionDefinition,
} from './engine'

const NO_CONDITIONS: PromotionConditions = {
  validFrom: null,
  validTo: null,
  daysOfWeek: [],
  startTime: null,
  endTime: null,
  branchIds: [],
  minSpendMinor: 0,
  categoryIds: [],
  menuItemIds: [],
  minQuantity: 0,
  requiredTierId: null,
  requiresVoucher: false,
}

function promo(
  id: string,
  overrides: Partial<PromotionDefinition> = {},
): PromotionDefinition {
  const { conditions, ...rest } = overrides

  return {
    id,
    name: id,
    kind: 'percentage',
    value: 1000,
    priority: 0,
    isStackable: true,
    usageRemaining: null,
    ...rest,
    conditions: { ...NO_CONDITIONS, ...conditions },
  }
}

function line(
  lineId: string,
  overrides: Partial<BillLineContext> = {},
): BillLineContext {
  return {
    lineId,
    menuItemId: `item-${lineId}`,
    categoryId: 'cat-food',
    quantity: 1,
    unitPriceMinor: 1000,
    lineTotalMinor: 1000,
    ...overrides,
  }
}

function context(overrides: Partial<BillContext> = {}): BillContext {
  const lines = overrides.lines ?? [line('a'), line('b')]
  return {
    now: new Date(2026, 7, 6, 13, 0),
    branchId: 'branch-1',
    subtotalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0),
    lines,
    customerTierId: null,
    unlockedPromotionIds: [],
    ...overrides,
  }
}

describe('isWithinTimeWindow', () => {
  const at = (h: number, m = 0) => new Date(2026, 7, 6, h, m)

  it('is always open with no window', () => {
    expect(isWithinTimeWindow(at(3), null, null)).toBe(true)
  })

  it('matches inside a normal window', () => {
    expect(isWithinTimeWindow(at(15), '14:00', '17:00')).toBe(true)
    expect(isWithinTimeWindow(at(13), '14:00', '17:00')).toBe(false)
  })

  it('excludes the end minute', () => {
    // A 14:00–17:00 happy hour ends at 17:00; ordering at 17:00 is too late.
    expect(isWithinTimeWindow(at(17), '14:00', '17:00')).toBe(false)
    expect(isWithinTimeWindow(at(16, 59), '14:00', '17:00')).toBe(true)
  })

  /**
   * A 22:00–02:00 late-night promotion is an ordinary thing to configure.
   * Treating start > end as invalid would quietly disable it.
   */
  it('handles a window crossing midnight', () => {
    expect(isWithinTimeWindow(at(23), '22:00', '02:00')).toBe(true)
    expect(isWithinTimeWindow(at(1), '22:00', '02:00')).toBe(true)
    expect(isWithinTimeWindow(at(12), '22:00', '02:00')).toBe(false)
  })
})

describe('scopedLines', () => {
  it('covers the whole bill with no product filter', () => {
    const ctx = context()
    expect(scopedLines(promo('p'), ctx.lines)).toHaveLength(2)
  })

  it('filters by item', () => {
    const ctx = context()
    const scoped = scopedLines(
      promo('p', { conditions: { ...NO_CONDITIONS, menuItemIds: ['item-a'] } }),
      ctx.lines,
    )
    expect(scoped.map((l) => l.lineId)).toEqual(['a'])
  })

  it('filters by category', () => {
    const lines = [line('a'), line('b', { categoryId: 'cat-drinks' })]
    const scoped = scopedLines(
      promo('p', {
        conditions: { ...NO_CONDITIONS, categoryIds: ['cat-drinks'] },
      }),
      lines,
    )
    expect(scoped.map((l) => l.lineId)).toEqual(['b'])
  })
})

describe('checkEligibility', () => {
  it('accepts an unconditional promotion', () => {
    expect(checkEligibility(promo('p'), context()).eligible).toBe(true)
  })

  it('rejects one that has not started', () => {
    const result = checkEligibility(
      promo('p', {
        conditions: { ...NO_CONDITIONS, validFrom: new Date(2030, 0, 1) },
      }),
      context(),
    )
    expect(result).toMatchObject({ eligible: false, reason: 'Not started yet' })
  })

  it('rejects an expired one', () => {
    const result = checkEligibility(
      promo('p', {
        conditions: { ...NO_CONDITIONS, validTo: new Date(2020, 0, 1) },
      }),
      context(),
    )
    expect(result).toMatchObject({ eligible: false, reason: 'Expired' })
  })

  it('rejects on the wrong day', () => {
    // 6 Aug 2026 is a Thursday (day 4).
    const result = checkEligibility(
      promo('p', { conditions: { ...NO_CONDITIONS, daysOfWeek: [0, 6] } }),
      context(),
    )
    expect(result.eligible).toBe(false)
  })

  it('rejects at another branch', () => {
    const result = checkEligibility(
      promo('p', { conditions: { ...NO_CONDITIONS, branchIds: ['other'] } }),
      context(),
    )
    expect(result.eligible).toBe(false)
  })

  it('rejects below minimum spend', () => {
    const result = checkEligibility(
      promo('p', { conditions: { ...NO_CONDITIONS, minSpendMinor: 999_999 } }),
      context(),
    )
    expect(result.eligible).toBe(false)
  })

  it('rejects on the wrong tier and accepts on the right one', () => {
    const gated = promo('p', {
      conditions: { ...NO_CONDITIONS, requiredTierId: 'gold' },
    })

    expect(checkEligibility(gated, context()).eligible).toBe(false)
    expect(
      checkEligibility(gated, context({ customerTierId: 'gold' })).eligible,
    ).toBe(true)
  })

  /**
   * A voucher promotion must never fire on its own. If this passes without
   * the code, every coupon in the system is effectively public.
   */
  it('rejects a voucher promotion until the code is presented', () => {
    const gated = promo('v', {
      conditions: { ...NO_CONDITIONS, requiresVoucher: true },
    })

    expect(checkEligibility(gated, context()).eligible).toBe(false)
    expect(
      checkEligibility(gated, context({ unlockedPromotionIds: ['v'] }))
        .eligible,
    ).toBe(true)
  })

  it('rejects when nothing on the bill qualifies', () => {
    const result = checkEligibility(
      promo('p', {
        conditions: { ...NO_CONDITIONS, menuItemIds: ['not-ordered'] },
      }),
      context(),
    )
    expect(result).toMatchObject({ reason: 'Nothing on the bill qualifies' })
  })

  it('rejects below the minimum quantity', () => {
    const result = checkEligibility(
      promo('p', { conditions: { ...NO_CONDITIONS, minQuantity: 5 } }),
      context(),
    )
    expect(result.eligible).toBe(false)
  })

  it('rejects when the usage limit is spent', () => {
    const result = checkEligibility(
      promo('p', { usageRemaining: 0 }),
      context(),
    )
    expect(result).toMatchObject({ reason: 'Usage limit reached' })
  })
})

describe('calculatePromotionDiscount', () => {
  it('takes a percentage of the whole bill', () => {
    expect(
      calculatePromotionDiscount(promo('p', { value: 1000 }), context()),
    ).toBe(200)
  })

  it('takes a percentage of only the scoped lines', () => {
    const value = calculatePromotionDiscount(
      promo('p', {
        value: 5000,
        conditions: { ...NO_CONDITIONS, menuItemIds: ['item-a'] },
      }),
      context(),
    )
    expect(value).toBe(500)
  })

  it('applies a fixed amount', () => {
    expect(
      calculatePromotionDiscount(
        promo('p', { kind: 'fixed', value: 300 }),
        context(),
      ),
    ).toBe(300)
  })

  /**
   * A RM 20 voucher against a RM 12 dish discounts 12, not 20 — otherwise the
   * promotion eats into items it was never meant to touch.
   */
  it('never discounts more than its scope is worth', () => {
    const value = calculatePromotionDiscount(
      promo('p', {
        kind: 'fixed',
        value: 99_999,
        conditions: { ...NO_CONDITIONS, menuItemIds: ['item-a'] },
      }),
      context(),
    )
    expect(value).toBe(1000)
  })

  describe('buy one get one', () => {
    it('frees one of a pair', () => {
      const lines = [line('a', { quantity: 2, lineTotalMinor: 2000 })]
      expect(
        calculatePromotionDiscount(
          promo('p', { kind: 'bogo' }),
          context({ lines }),
        ),
      ).toBe(1000)
    })

    it('frees nothing for a single item', () => {
      const lines = [line('a', { quantity: 1 })]
      expect(
        calculatePromotionDiscount(
          promo('p', { kind: 'bogo' }),
          context({ lines }),
        ),
      ).toBe(0)
    })

    /**
     * Freeing the dearest would let someone pair a coffee with a steak and
     * take the steak.
     */
    it('frees the cheaper of a mismatched pair', () => {
      const lines = [
        line('steak', { unitPriceMinor: 8000, lineTotalMinor: 8000 }),
        line('coffee', { unitPriceMinor: 500, lineTotalMinor: 500 }),
      ]
      expect(
        calculatePromotionDiscount(
          promo('p', { kind: 'bogo' }),
          context({ lines }),
        ),
      ).toBe(500)
    })

    it('frees two of four', () => {
      const lines = [line('a', { quantity: 4, lineTotalMinor: 4000 })]
      expect(
        calculatePromotionDiscount(
          promo('p', { kind: 'bogo' }),
          context({ lines }),
        ),
      ).toBe(2000)
    })
  })

  it('frees the single cheapest qualifying item', () => {
    const lines = [
      line('a', { unitPriceMinor: 2000, lineTotalMinor: 2000 }),
      line('b', { unitPriceMinor: 700, lineTotalMinor: 700 }),
    ]
    expect(
      calculatePromotionDiscount(
        promo('p', { kind: 'free_item' }),
        context({ lines }),
      ),
    ).toBe(700)
  })
})

describe('evaluatePromotions', () => {
  it('applies a single eligible promotion', () => {
    const result = evaluatePromotions([promo('p')], context())

    expect(result.applied).toHaveLength(1)
    expect(result.totalDiscountMinor).toBe(200)
  })

  it('combines stackable promotions', () => {
    const result = evaluatePromotions(
      [
        promo('a', { value: 1000, isStackable: true }),
        promo('b', { kind: 'fixed', value: 300, isStackable: true }),
      ],
      context(),
    )

    expect(result.applied).toHaveLength(2)
    expect(result.totalDiscountMinor).toBe(500)
  })

  it('applies a non-stackable promotion alone', () => {
    const result = evaluatePromotions(
      [
        promo('solo', { priority: 0, isStackable: false, value: 2000 }),
        promo('other', { priority: 1, isStackable: true }),
      ],
      context(),
    )

    expect(result.applied.map((a) => a.promotionId)).toEqual(['solo'])
  })

  /**
   * A promotion that qualified and lost still needs a reason. Silence is
   * exactly what someone is trying to escape when they open the admin screen
   * asking why their promotion did nothing.
   */
  it('explains promotions displaced by a non-stackable one', () => {
    const result = evaluatePromotions(
      [
        promo('solo', { priority: 0, isStackable: false, value: 2000 }),
        promo('displaced', { priority: 1, isStackable: true }),
      ],
      context(),
    )

    expect(result.applied.map((a) => a.promotionId)).toEqual(['solo'])
    expect(result.rejected).toContainEqual(
      expect.objectContaining({
        promotionId: 'displaced',
        reason: 'Superseded by "solo", which cannot be combined',
      }),
    )
  })

  it('respects priority order', () => {
    const result = evaluatePromotions(
      [
        promo('late', { priority: 10, isStackable: false, value: 5000 }),
        promo('early', { priority: 1, isStackable: false, value: 500 }),
      ],
      context(),
    )

    // Priority wins over size — that is what configuring a priority means.
    expect(result.applied.map((a) => a.promotionId)).toEqual(['early'])
  })

  /**
   * When two promotions of equal priority both qualify, the customer should
   * get the better one — and the outcome must not depend on array order.
   */
  it('prefers the larger discount at equal priority', () => {
    const result = evaluatePromotions(
      [
        promo('small', { isStackable: false, value: 500 }),
        promo('big', { isStackable: false, value: 5000 }),
      ],
      context(),
    )

    expect(result.applied.map((a) => a.promotionId)).toEqual(['big'])
  })

  it('is deterministic for identical promotions', () => {
    const promotions = [
      promo('bbb', { isStackable: false }),
      promo('aaa', { isStackable: false }),
    ]

    const first = evaluatePromotions(promotions, context())
    for (let i = 0; i < 20; i++) {
      expect(evaluatePromotions(promotions, context())).toEqual(first)
    }
    expect(first.applied[0].promotionId).toBe('aaa')
  })

  it('explains why each rejected promotion did not apply', () => {
    const result = evaluatePromotions(
      [promo('expired', { conditions: { ...NO_CONDITIONS, validTo: new Date(2020, 0, 1) } })],
      context(),
    )

    expect(result.applied).toHaveLength(0)
    expect(result.rejected[0]).toMatchObject({ reason: 'Expired' })
  })

  it('rejects a promotion worth nothing rather than applying it', () => {
    const result = evaluatePromotions([promo('zero', { value: 0 })], context())

    expect(result.applied).toHaveLength(0)
    expect(result.rejected[0].reason).toBe('Worth nothing on this bill')
  })

  /**
   * A stack of generous promotions makes a bill free, never negative — a
   * negative total would turn a configuration mistake into the restaurant
   * owing money.
   */
  it('caps the total at the subtotal', () => {
    const result = evaluatePromotions(
      [
        promo('a', { kind: 'fixed', value: 99_999, isStackable: true }),
        promo('b', { kind: 'fixed', value: 99_999, isStackable: true }),
      ],
      context(),
    )

    expect(result.totalDiscountMinor).toBe(2000)
  })

  it('applies nothing to an empty bill', () => {
    const result = evaluatePromotions(
      [promo('p')],
      context({ lines: [], subtotalMinor: 0 }),
    )

    expect(result.applied).toHaveLength(0)
    expect(result.totalDiscountMinor).toBe(0)
  })

  it('returns integers throughout', () => {
    const result = evaluatePromotions(
      [promo('odd', { value: 733 })],
      context({ lines: [line('a', { lineTotalMinor: 1249 })] }),
    )

    for (const applied of result.applied) {
      expect(Number.isInteger(applied.discountMinor)).toBe(true)
    }
    expect(Number.isInteger(result.totalDiscountMinor)).toBe(true)
  })
})
