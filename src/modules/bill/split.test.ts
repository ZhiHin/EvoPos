import { describe, expect, it } from 'vitest'

import { ValidationError } from '@/lib/errors'
import { calculateBill, type BillSettings } from '@/modules/pos/bill'
import {
  allocate,
  assertSplitBalances,
  computeSplit,
  type SplitLine,
  type SplitParticipant,
  type SplitStrategy,
} from './split'

const NO_CHARGES: BillSettings = {
  taxRateBasisPoints: 0,
  serviceChargeBasisPoints: 0,
  taxInclusive: false,
}

const MALAYSIAN: BillSettings = {
  taxRateBasisPoints: 600,
  serviceChargeBasisPoints: 1000,
  taxInclusive: false,
}

const INCLUSIVE: BillSettings = { ...MALAYSIAN, taxInclusive: true }

const ALI: SplitParticipant = { memberId: 'ali', displayName: 'Ali' }
const BEE: SplitParticipant = { memberId: 'bee', displayName: 'Bee' }
const CAT: SplitParticipant = { memberId: 'cat', displayName: 'Cat' }

function line(
  lineId: string,
  memberId: string | null,
  lineTotalMinor: number,
  quantity = 1,
): SplitLine {
  return {
    lineId,
    memberId,
    nameSnapshot: lineId,
    quantity,
    lineTotalMinor,
  }
}

describe('allocate — the exactness invariant', () => {
  it('splits evenly when it divides cleanly', () => {
    expect(allocate(900, [1, 1, 1])).toEqual([300, 300, 300])
  })

  /**
   * The case the whole engine exists for. 1000 ÷ 3 is 333.33; three lots of
   * 333 is 999, and that missing cent has to land somewhere.
   */
  it('never loses the leftover cent', () => {
    const parts = allocate(1000, [1, 1, 1])

    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000)
    expect(parts.sort()).toEqual([333, 333, 334])
  })

  it('sums exactly for every total across many divisors', () => {
    for (let total = 0; total <= 400; total++) {
      for (let people = 1; people <= 7; people++) {
        const parts = allocate(total, Array(people).fill(1))
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
        expect(parts.every(Number.isInteger)).toBe(true)
      }
    }
  })

  it('sums exactly with lopsided weights', () => {
    for (const weights of [
      [1, 2, 3],
      [7, 1, 1, 1],
      [5, 5],
      [1, 0, 0],
      [99, 1],
    ]) {
      for (const total of [1, 7, 101, 1000, 12_345]) {
        expect(allocate(total, weights).reduce((a, b) => a + b, 0)).toBe(total)
      }
    }
  })

  it('is deterministic — the same input always gives the same answer', () => {
    // A number shown on screen and a number written to the database a second
    // later must agree, or a customer sees one figure and is charged another.
    const first = allocate(1000, [1, 1, 1])
    for (let i = 0; i < 50; i++) {
      expect(allocate(1000, [1, 1, 1])).toEqual(first)
    }
  })

  it('gives the leftover to the earliest participant on a tie', () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333])
  })

  it('respects proportional weights', () => {
    expect(allocate(1000, [1, 3])).toEqual([250, 750])
  })

  it('gives nothing to a zero weight when others are positive', () => {
    expect(allocate(900, [1, 1, 0])).toEqual([450, 450, 0])
  })

  it('spreads evenly rather than discarding when all weights are zero', () => {
    // Losing money silently is worse than an arbitrary but exact answer.
    const parts = allocate(900, [0, 0, 0])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(900)
  })

  it('handles a zero total and a single participant', () => {
    expect(allocate(0, [1, 1, 1])).toEqual([0, 0, 0])
    expect(allocate(1234, [1])).toEqual([1234])
  })

  it('returns nothing for no participants', () => {
    expect(allocate(100, [])).toEqual([])
  })

  it('rejects fractional totals and negative weights', () => {
    expect(() => allocate(10.5, [1, 1])).toThrow(ValidationError)
    expect(() => allocate(100, [1, -1])).toThrow(ValidationError)
  })
})

describe('computeSplit — by owner', () => {
  const lines = [
    line('ali-nasi', 'ali', 1200),
    line('bee-kopi', 'bee', 500),
    line('shared-satay', null, 1000),
  ]

  it('gives each person their own items plus an even share of the shared', () => {
    const totals = calculateBill(
      lines.map((l) => l.lineTotalMinor),
      NO_CHARGES,
    )

    const result = computeSplit(lines, [ALI, BEE], totals, { kind: 'by_owner' })

    const ali = result.shares.find((s) => s.memberId === 'ali')!
    const bee = result.shares.find((s) => s.memberId === 'bee')!

    expect(ali.totalMinor).toBe(1200 + 500)
    expect(bee.totalMinor).toBe(500 + 500)
    assertSplitBalances(result, totals)
  })

  it('lists which dishes each share came from', () => {
    const totals = calculateBill(
      lines.map((l) => l.lineTotalMinor),
      NO_CHARGES,
    )
    const result = computeSplit(lines, [ALI, BEE], totals, { kind: 'by_owner' })

    const ali = result.shares.find((s) => s.memberId === 'ali')!
    expect(ali.lines.map((l) => l.lineId).sort()).toEqual([
      'ali-nasi',
      'shared-satay',
    ])
    expect(ali.lines.find((l) => l.lineId === 'shared-satay')!.isShared).toBe(
      true,
    )
  })

  /**
   * Someone leaving does not make their dinner free. Their dish falls back to
   * the table rather than dropping out of the bill entirely.
   */
  it('falls back to the table when an owner has left', () => {
    const totals = calculateBill(
      lines.map((l) => l.lineTotalMinor),
      NO_CHARGES,
    )

    // Bee has gone home; only Ali and Cat remain.
    const result = computeSplit(lines, [ALI, CAT], totals, {
      kind: 'by_owner',
    })

    assertSplitBalances(result, totals)
    expect(
      result.shares.reduce((sum, s) => sum + s.totalMinor, 0),
    ).toBe(2700)
  })
})

describe('computeSplit — even', () => {
  it('divides everything equally regardless of who ordered', () => {
    const lines = [line('a', 'ali', 1000), line('b', 'bee', 2000)]
    const totals = calculateBill([1000, 2000], NO_CHARGES)

    const result = computeSplit(lines, [ALI, BEE], totals, { kind: 'even' })

    expect(result.shares.map((s) => s.totalMinor)).toEqual([1500, 1500])
    assertSplitBalances(result, totals)
  })

  it('stays exact with an awkward total across three people', () => {
    const lines = [line('a', null, 1000)]
    const totals = calculateBill([1000], NO_CHARGES)

    const result = computeSplit(lines, [ALI, BEE, CAT], totals, {
      kind: 'even',
    })

    expect(result.shares.map((s) => s.totalMinor).sort()).toEqual([
      333, 333, 334,
    ])
    assertSplitBalances(result, totals)
  })
})

describe('computeSplit — by percentage', () => {
  it('divides by the given proportions', () => {
    const lines = [line('a', null, 10_000)]
    const totals = calculateBill([10_000], NO_CHARGES)

    const result = computeSplit(lines, [ALI, BEE], totals, {
      kind: 'by_percentage',
      weights: { ali: 7000, bee: 3000 },
    })

    expect(result.shares.find((s) => s.memberId === 'ali')!.totalMinor).toBe(
      7000,
    )
    expect(result.shares.find((s) => s.memberId === 'bee')!.totalMinor).toBe(
      3000,
    )
  })

  it('rejects percentages that do not total 100%', () => {
    const lines = [line('a', null, 1000)]
    const totals = calculateBill([1000], NO_CHARGES)

    expect(() =>
      computeSplit(lines, [ALI, BEE], totals, {
        kind: 'by_percentage',
        weights: { ali: 5000, bee: 4000 },
      }),
    ).toThrow(ValidationError)
  })

  it('rejects a percentage for someone not at the table', () => {
    const lines = [line('a', null, 1000)]
    const totals = calculateBill([1000], NO_CHARGES)

    expect(() =>
      computeSplit(lines, [ALI], totals, {
        kind: 'by_percentage',
        weights: { ali: 5000, ghost: 5000 },
      }),
    ).toThrow(ValidationError)
  })
})

describe('computeSplit — by item', () => {
  const lines = [
    line('satay', null, 1200, 4),
    line('kopi', null, 600, 2),
    line('forgotten', null, 500, 1),
  ]

  it('assigns whole lines to the named person', () => {
    const totals = calculateBill([1200, 600, 500], NO_CHARGES)

    const result = computeSplit(lines, [ALI, BEE], totals, {
      kind: 'by_item',
      assignments: [
        { lineId: 'satay', memberId: 'ali' },
        { lineId: 'kopi', memberId: 'bee' },
      ],
    })

    const ali = result.shares.find((s) => s.memberId === 'ali')!
    const bee = result.shares.find((s) => s.memberId === 'bee')!

    // 'forgotten' was unassigned, so it splits evenly: 250 each.
    expect(ali.totalMinor).toBe(1200 + 250)
    expect(bee.totalMinor).toBe(600 + 250)
    assertSplitBalances(result, totals)
  })

  it('splits one line by quantity', () => {
    const totals = calculateBill([1200], NO_CHARGES)

    const result = computeSplit([lines[0]], [ALI, BEE], totals, {
      kind: 'by_item',
      assignments: [
        { lineId: 'satay', memberId: 'ali', quantity: 3 },
        { lineId: 'satay', memberId: 'bee', quantity: 1 },
      ],
    })

    expect(result.shares.find((s) => s.memberId === 'ali')!.totalMinor).toBe(
      900,
    )
    expect(result.shares.find((s) => s.memberId === 'bee')!.totalMinor).toBe(
      300,
    )
  })

  /**
   * An unassigned dish must not silently go unpaid — it falls to the table,
   * which is the outcome that keeps the bill balancing.
   */
  it('shares anything left unassigned', () => {
    const totals = calculateBill([1200, 600, 500], NO_CHARGES)
    const result = computeSplit(lines, [ALI, BEE], totals, {
      kind: 'by_item',
      assignments: [],
    })

    assertSplitBalances(result, totals)
  })

  it('rejects assigning more portions than were ordered', () => {
    const totals = calculateBill([1200], NO_CHARGES)

    expect(() =>
      computeSplit([lines[0]], [ALI, BEE], totals, {
        kind: 'by_item',
        assignments: [
          { lineId: 'satay', memberId: 'ali', quantity: 3 },
          { lineId: 'satay', memberId: 'bee', quantity: 3 },
        ],
      }),
    ).toThrow(ValidationError)
  })

  it('rejects an item that is not on the bill', () => {
    const totals = calculateBill([1200], NO_CHARGES)

    expect(() =>
      computeSplit([lines[0]], [ALI], totals, {
        kind: 'by_item',
        assignments: [{ lineId: 'ghost', memberId: 'ali' }],
      }),
    ).toThrow(ValidationError)
  })
})

describe('computeSplit — tax, service charge and discounts', () => {
  it('allocates service charge and tax in proportion to the subtotal', () => {
    const lines = [line('a', 'ali', 3000), line('b', 'bee', 1000)]
    const totals = calculateBill([3000, 1000], MALAYSIAN)

    const result = computeSplit(lines, [ALI, BEE], totals, {
      kind: 'by_owner',
    })

    const ali = result.shares.find((s) => s.memberId === 'ali')!
    const bee = result.shares.find((s) => s.memberId === 'bee')!

    // 75/25 of the subtotal, so 75/25 of the charges.
    expect(ali.serviceChargeMinor).toBe(300)
    expect(bee.serviceChargeMinor).toBe(100)
    assertSplitBalances(result, totals)
  })

  it('spreads a discount across everyone', () => {
    const lines = [line('a', 'ali', 3000), line('b', 'bee', 1000)]
    const totals = calculateBill([3000, 1000], MALAYSIAN, [
      { type: 'percentage', value: 1000, reason: '10% off' },
    ])

    const result = computeSplit(lines, [ALI, BEE], totals, {
      kind: 'by_owner',
    })

    expect(
      result.shares.reduce((sum, s) => sum + s.discountMinor, 0),
    ).toBe(totals.discountMinor)
    assertSplitBalances(result, totals)
  })

  /**
   * Inclusive tax is already inside the line prices. Adding each person's
   * share on top would charge it twice and the split would exceed the bill.
   */
  it('does not add inclusive tax on top of a share', () => {
    const lines = [line('a', 'ali', 3000), line('b', 'bee', 1000)]
    const totals = calculateBill([3000, 1000], INCLUSIVE)

    const result = computeSplit(lines, [ALI, BEE], totals, {
      kind: 'by_owner',
    })

    assertSplitBalances(result, totals)
    expect(result.shares.every((s) => s.taxMinor >= 0)).toBe(true)
  })

  it('balances for a fully comped bill', () => {
    const lines = [line('a', 'ali', 3000), line('b', 'bee', 1000)]
    const totals = calculateBill([3000, 1000], MALAYSIAN, [
      { type: 'fixed', value: 99_999, reason: 'comped' },
    ])

    const result = computeSplit(lines, [ALI, BEE], totals, {
      kind: 'by_owner',
    })

    expect(totals.totalMinor).toBe(0)
    assertSplitBalances(result, totals)
  })
})

describe('computeSplit — the invariant holds everywhere', () => {
  /**
   * A brute-force sweep. If any combination of strategy, party size and
   * awkward pricing can make the shares disagree with the bill by a cent,
   * this finds it.
   */
  it('always sums to exactly the bill total', () => {
    const strategies: SplitStrategy[] = [
      { kind: 'by_owner' },
      { kind: 'even' },
    ]

    for (const settings of [NO_CHARGES, MALAYSIAN, INCLUSIVE]) {
      for (const amounts of [
        [1],
        [7, 11],
        [333, 333, 333],
        [1299, 850, 1000],
        [99_999, 1],
        [0, 1000],
      ]) {
        const participants = [ALI, BEE, CAT].slice(
          0,
          Math.max(1, amounts.length),
        )

        const lines = amounts.map((amount, index) =>
          line(
            `l${index}`,
            index % 2 === 0 ? null : participants[0].memberId,
            amount,
          ),
        )

        const totals = calculateBill(amounts, settings, [
          { type: 'percentage', value: 733, reason: 'odd discount' },
        ])

        for (const strategy of strategies) {
          const result = computeSplit(lines, participants, totals, strategy)
          expect(() => assertSplitBalances(result, totals)).not.toThrow()
        }
      }
    }
  })

  it('refuses to split with nobody at the table', () => {
    const totals = calculateBill([1000], NO_CHARGES)
    expect(() =>
      computeSplit([line('a', null, 1000)], [], totals, { kind: 'even' }),
    ).toThrow(ValidationError)
  })
})
