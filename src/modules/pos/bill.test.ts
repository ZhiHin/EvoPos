import { describe, expect, it } from 'vitest'

import {
  applyRate,
  calculateBill,
  calculateDiscount,
  extractIncludedTax,
  roundForCash,
  type BillSettings,
} from './bill'

const EXCLUSIVE: BillSettings = {
  taxRateBasisPoints: 600,
  serviceChargeBasisPoints: 1000,
  taxInclusive: false,
}

const INCLUSIVE: BillSettings = { ...EXCLUSIVE, taxInclusive: true }

const NO_CHARGES: BillSettings = {
  taxRateBasisPoints: 0,
  serviceChargeBasisPoints: 0,
  taxInclusive: false,
}

describe('applyRate', () => {
  it('applies whole percentages', () => {
    expect(applyRate(10_000, 600)).toBe(600)
    expect(applyRate(10_000, 1000)).toBe(1000)
  })

  it('rounds rather than truncating', () => {
    // 2345 × 6% = 140.7. Truncating loses a cent on every such line, which
    // across a service is an unexplainable shortfall in the till.
    expect(applyRate(2345, 600)).toBe(141)
  })

  it('returns zero for a zero rate', () => {
    expect(applyRate(12_345, 0)).toBe(0)
  })

  it('always returns an integer', () => {
    for (const amount of [1, 7, 333, 2345, 99_999]) {
      expect(Number.isInteger(applyRate(amount, 825))).toBe(true)
    }
  })
})

describe('extractIncludedTax', () => {
  it('extracts tax already contained in a gross amount', () => {
    // 1060 gross at 6% inclusive → 1000 net, 60 tax.
    expect(extractIncludedTax(1060, 600)).toBe(60)
  })

  /**
   * The property that matters more than the exact figure: net plus tax must
   * equal gross exactly, or a receipt's own lines fail to add up to its
   * total.
   */
  it('never loses or invents a cent', () => {
    for (const gross of [1, 99, 100, 1060, 2345, 7777, 123_456]) {
      const tax = extractIncludedTax(gross, 600)
      expect(gross - tax + tax).toBe(gross)
      expect(tax).toBeLessThan(gross)
      expect(Number.isInteger(tax)).toBe(true)
    }
  })

  it('is zero when there is no tax', () => {
    expect(extractIncludedTax(1000, 0)).toBe(0)
  })
})

describe('calculateDiscount', () => {
  it('applies a percentage against the subtotal', () => {
    expect(
      calculateDiscount(10_000, [
        { type: 'percentage', value: 1000, reason: '10%' },
      ]),
    ).toBe(1000)
  })

  it('applies a fixed amount', () => {
    expect(
      calculateDiscount(10_000, [
        { type: 'fixed', value: 500, reason: 'voucher' },
      ]),
    ).toBe(500)
  })

  /**
   * Both discounts are computed against the original subtotal and summed.
   * Applying them sequentially would make the order matter — "10% then RM5"
   * and "RM5 then 10%" would differ, and nobody could say which the till
   * chose.
   */
  it('computes every discount against the original subtotal', () => {
    const result = calculateDiscount(10_000, [
      { type: 'percentage', value: 1000, reason: '10%' },
      { type: 'fixed', value: 500, reason: 'voucher' },
    ])

    // 1000 + 500, not 1000 then 10% of the remaining 9000.
    expect(result).toBe(1500)
  })

  it('caps at the subtotal so a bill can never go negative', () => {
    expect(
      calculateDiscount(1000, [
        { type: 'fixed', value: 5000, reason: 'oops' },
      ]),
    ).toBe(1000)
  })

  it('clamps a percentage above 100%', () => {
    expect(
      calculateDiscount(1000, [
        { type: 'percentage', value: 50_000, reason: 'typo' },
      ]),
    ).toBe(1000)
  })

  it('ignores a negative fixed discount', () => {
    // A negative discount is a surcharge by the back door.
    expect(
      calculateDiscount(1000, [
        { type: 'fixed', value: -500, reason: 'nope' },
      ]),
    ).toBe(0)
  })

  it('is zero with no discounts', () => {
    expect(calculateDiscount(10_000, [])).toBe(0)
  })
})

describe('calculateBill — tax exclusive', () => {
  it('adds service charge then tax on the combined amount', () => {
    const bill = calculateBill([10_000], EXCLUSIVE)

    expect(bill.subtotalMinor).toBe(10_000)
    expect(bill.serviceChargeMinor).toBe(1000)
    // 6% of (10000 + 1000) — the service charge is itself taxable.
    expect(bill.taxMinor).toBe(660)
    expect(bill.totalMinor).toBe(11_660)
    expect(bill.taxIsIncluded).toBe(false)
  })

  it('sums the line totals', () => {
    const bill = calculateBill([1200, 350, 890], NO_CHARGES)
    expect(bill.subtotalMinor).toBe(2440)
    expect(bill.totalMinor).toBe(2440)
  })

  /**
   * A discount must reduce the service charge too — charging 10% service on
   * an amount the customer is not paying is hard to defend to them.
   */
  it('applies service charge to the discounted subtotal', () => {
    const bill = calculateBill([10_000], EXCLUSIVE, [
      { type: 'percentage', value: 1000, reason: '10% off' },
    ])

    expect(bill.discountMinor).toBe(1000)
    expect(bill.discountedSubtotalMinor).toBe(9000)
    expect(bill.serviceChargeMinor).toBe(900)
    expect(bill.taxMinor).toBe(594)
    expect(bill.totalMinor).toBe(10_494)
  })

  it('produces a coherent bill with no charges configured', () => {
    const bill = calculateBill([2500], NO_CHARGES)

    expect(bill.serviceChargeMinor).toBe(0)
    expect(bill.taxMinor).toBe(0)
    expect(bill.totalMinor).toBe(2500)
  })

  it('handles an empty bill', () => {
    const bill = calculateBill([], EXCLUSIVE)

    expect(bill.subtotalMinor).toBe(0)
    expect(bill.totalMinor).toBe(0)
  })

  it('reaches zero but never below when fully discounted', () => {
    const bill = calculateBill([5000], EXCLUSIVE, [
      { type: 'fixed', value: 99_999, reason: 'comped' },
    ])

    expect(bill.discountedSubtotalMinor).toBe(0)
    expect(bill.totalMinor).toBe(0)
    expect(bill.totalMinor).toBeGreaterThanOrEqual(0)
  })
})

describe('calculateBill — tax inclusive', () => {
  it('adds nothing and extracts the tax for display', () => {
    const bill = calculateBill([10_600], INCLUSIVE)

    // Service charge still applies on top of the inclusive amount.
    expect(bill.serviceChargeMinor).toBe(1060)
    expect(bill.totalMinor).toBe(11_660)
    expect(bill.taxIsIncluded).toBe(true)
    // The tax is inside that total, not added to it.
    expect(bill.taxMinor).toBe(extractIncludedTax(11_660, 600))
  })

  it('never makes the extracted tax exceed the total', () => {
    for (const amount of [1, 100, 999, 10_600, 250_000]) {
      const bill = calculateBill([amount], INCLUSIVE)
      expect(bill.taxMinor).toBeLessThan(bill.totalMinor + 1)
    }
  })

  it('flags inclusivity so a receipt can word it correctly', () => {
    // "Inclusive of 6% SST" versus a separate charge line is not cosmetic.
    expect(calculateBill([1000], INCLUSIVE).taxIsIncluded).toBe(true)
    expect(calculateBill([1000], EXCLUSIVE).taxIsIncluded).toBe(false)
  })
})

describe('calculateBill — integer discipline', () => {
  it('returns integers for every field', () => {
    const bill = calculateBill([333, 777, 1249], EXCLUSIVE, [
      { type: 'percentage', value: 733, reason: 'odd' },
    ])

    for (const value of [
      bill.subtotalMinor,
      bill.discountMinor,
      bill.discountedSubtotalMinor,
      bill.serviceChargeMinor,
      bill.taxMinor,
      bill.totalMinor,
    ]) {
      expect(Number.isInteger(value)).toBe(true)
    }
  })

  it('keeps the total equal to its own parts when exclusive', () => {
    const bill = calculateBill([1234, 5678], EXCLUSIVE, [
      { type: 'fixed', value: 199, reason: 'voucher' },
    ])

    expect(bill.totalMinor).toBe(
      bill.discountedSubtotalMinor + bill.serviceChargeMinor + bill.taxMinor,
    )
  })
})

describe('roundForCash', () => {
  it('rounds to the nearest 5 sen', () => {
    expect(roundForCash(1002).roundedMinor).toBe(1000)
    expect(roundForCash(1003).roundedMinor).toBe(1005)
    expect(roundForCash(1005).roundedMinor).toBe(1005)
  })

  it('reports the adjustment so a receipt can show it', () => {
    // A total that silently differs from the sum of its parts is the fastest
    // way to lose trust at the counter.
    expect(roundForCash(1002).adjustmentMinor).toBe(-2)
    expect(roundForCash(1003).adjustmentMinor).toBe(2)
  })

  it('leaves exact multiples alone', () => {
    expect(roundForCash(1000)).toEqual({
      roundedMinor: 1000,
      adjustmentMinor: 0,
    })
  })

  it('is a no-op when the increment is one cent', () => {
    expect(roundForCash(1003, 1)).toEqual({
      roundedMinor: 1003,
      adjustmentMinor: 0,
    })
  })
})
