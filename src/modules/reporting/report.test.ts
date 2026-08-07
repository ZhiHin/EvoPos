import { describe, expect, it } from 'vitest'

import { formatZonedDate, zonedTimeToInstant } from '@/lib/time'
import {
  bucketKeyOf,
  bucketSales,
  businessDayOf,
  businessDayRange,
  clampBusinessDayStart,
  compare,
  describeRange,
  distributeByHour,
  previousRange,
  ratioBasisPoints,
  summariseSales,
  todayRange,
  type SalesRecord,
} from './report'

const KL = 'Asia/Kuala_Lumpur'
/** A zone with daylight saving, so the offset arithmetic is actually tested. */
const LONDON = 'Europe/London'

function record(overrides: Partial<SalesRecord> = {}): SalesRecord {
  return {
    settledAt: new Date('2026-08-07T12:00:00Z'),
    subtotalMinor: 10_000,
    discountMinor: 0,
    serviceChargeMinor: 1_000,
    taxMinor: 660,
    totalMinor: 11_660,
    refundedMinor: 0,
    costMinor: 3_000,
    costedSubtotalMinor: 10_000,
    covers: 2,
    ...overrides,
  }
}

describe('time zones', () => {
  it('resolves local midnight to the right instant, not the server’s', () => {
    // 00:00 in Kuala Lumpur is 16:00 the previous day in UTC. A server in UTC
    // parsing '2026-08-07T00:00:00' would get 08:00 local, and a day's
    // takings would run from breakfast to breakfast.
    const midnight = zonedTimeToInstant(KL, 2026, 8, 7)
    expect(midnight.toISOString()).toBe('2026-08-06T16:00:00.000Z')
  })

  it('resolves midnight either side of a daylight saving change', () => {
    // London is UTC+1 in July and UTC+0 in January. A fixed offset would be
    // wrong for half the year.
    expect(zonedTimeToInstant(LONDON, 2026, 7, 1).toISOString()).toBe(
      '2026-06-30T23:00:00.000Z',
    )
    expect(zonedTimeToInstant(LONDON, 2026, 1, 1).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    )
  })

  it('round-trips a local date through an instant and back', () => {
    for (const month of [1, 3, 6, 10, 12]) {
      const instant = zonedTimeToInstant(LONDON, 2026, month, 15, 12 * 60)
      expect(formatZonedDate(instant, LONDON)).toBe(
        `2026-${String(month).padStart(2, '0')}-15`,
      )
    }
  })
})

describe('the business day', () => {
  it('puts a bill paid before midnight in that day', () => {
    const at = zonedTimeToInstant(KL, 2026, 8, 7, 23 * 60 + 30)
    expect(businessDayOf(at, KL)).toBe('2026-08-07')
  })

  it('keeps a 01:30 bill in the night it belongs to', () => {
    const at = zonedTimeToInstant(KL, 2026, 8, 8, 90)

    // Midnight cutoff: it is a new day, and the night's trade is split in two.
    expect(businessDayOf(at, KL, 0)).toBe('2026-08-08')

    // A 04:00 cutoff keeps one service in one day, which is what the bar
    // manager counting the drawer at 03:00 actually means by "tonight".
    expect(businessDayOf(at, KL, 240)).toBe('2026-08-07')
  })

  it('starts the next day once the cutoff passes', () => {
    const at = zonedTimeToInstant(KL, 2026, 8, 8, 5 * 60)
    expect(businessDayOf(at, KL, 240)).toBe('2026-08-08')
  })

  it('refuses a cutoff past midday', () => {
    // A day starting at 14:00 no longer names the day it belongs to, and the
    // ambiguity would be silent.
    expect(clampBusinessDayStart(900)).toBe(719)
    expect(clampBusinessDayStart(-60)).toBe(0)
    expect(clampBusinessDayStart(Number.NaN)).toBe(0)
  })

  it('builds an inclusive range from two dates', () => {
    const range = businessDayRange('2026-08-01', '2026-08-07', KL)

    // Seven days, not six: a manager asking for the 1st to the 7th means
    // seven days of trade.
    expect(range).not.toBeNull()
    expect(range!.to.getTime() - range!.from.getTime()).toBe(
      7 * 24 * 60 * 60_000,
    )
    expect(range!.from.toISOString()).toBe('2026-07-31T16:00:00.000Z')
  })

  it('shifts the whole range when the day starts late', () => {
    const range = businessDayRange('2026-08-07', '2026-08-07', KL, 240)!
    expect(range.from.toISOString()).toBe('2026-08-06T20:00:00.000Z')
    expect(range.to.toISOString()).toBe('2026-08-07T20:00:00.000Z')
  })

  it('rejects a malformed or reversed range', () => {
    expect(businessDayRange('not-a-date', '2026-08-07', KL)).toBeNull()
    expect(businessDayRange('2026-02-31', '2026-03-01', KL)).toBeNull()
    expect(businessDayRange('2026-08-07', '2026-08-01', KL)).toBeNull()
  })

  it('brackets the current instant', () => {
    const now = zonedTimeToInstant(KL, 2026, 8, 7, 19 * 60)
    const range = todayRange(now, KL)

    expect(range.from.getTime()).toBeLessThanOrEqual(now.getTime())
    expect(range.to.getTime()).toBeGreaterThan(now.getTime())
  })

  it('compares against a period of its own length', () => {
    const range = businessDayRange('2026-02-01', '2026-02-28', KL)!
    const before = previousRange(range)

    // 28 days back, not "January" — comparing a 28-day February against a
    // 31-day January reports a good month as a collapse.
    expect(range.from.getTime() - before.from.getTime()).toBe(
      28 * 24 * 60 * 60_000,
    )
  })

  it('labels a range by business day at both ends', () => {
    const range = businessDayRange('2026-08-07', '2026-08-07', KL, 240)!
    expect(describeRange(range, KL, 240)).toBe('2026-08-07')

    const week = businessDayRange('2026-08-01', '2026-08-07', KL)!
    expect(describeRange(week, KL)).toBe('2026-08-01 to 2026-08-07')
  })
})

describe('bucketing', () => {
  it('keys a week by the Monday that starts it', () => {
    // 2026-08-07 is a Friday; 2026-08-09 is the Sunday that ends the week.
    const friday = zonedTimeToInstant(KL, 2026, 8, 7, 12 * 60)
    const sunday = zonedTimeToInstant(KL, 2026, 8, 9, 12 * 60)

    expect(bucketKeyOf(friday, 'week', KL)).toBe('2026-08-03')
    // Sunday belongs to the week that began the previous Monday, not the one
    // starting tomorrow.
    expect(bucketKeyOf(sunday, 'week', KL)).toBe('2026-08-03')
  })

  it('keys a month without a day', () => {
    const at = zonedTimeToInstant(KL, 2026, 8, 7, 12 * 60)
    expect(bucketKeyOf(at, 'month', KL)).toBe('2026-08')
  })

  it('omits buckets with no trade rather than drawing them as zero', () => {
    const buckets = bucketSales(
      [
        record({ settledAt: zonedTimeToInstant(KL, 2026, 8, 1, 720) }),
        record({ settledAt: zonedTimeToInstant(KL, 2026, 8, 3, 720) }),
      ],
      'day',
      KL,
    )

    // The 2nd is absent. A closing day drawn as a zero looks like a disaster.
    expect(buckets.map((b) => b.key)).toEqual(['2026-08-01', '2026-08-03'])
  })

  it('sorts buckets chronologically', () => {
    const buckets = bucketSales(
      [
        record({ settledAt: zonedTimeToInstant(KL, 2026, 9, 1, 720) }),
        record({ settledAt: zonedTimeToInstant(KL, 2026, 8, 1, 720) }),
      ],
      'month',
      KL,
    )
    expect(buckets.map((b) => b.key)).toEqual(['2026-08', '2026-09'])
  })
})

describe('summarising sales', () => {
  it('returns zeroes and no margin for an empty period', () => {
    const summary = summariseSales([])

    expect(summary.bills).toBe(0)
    expect(summary.totalMinor).toBe(0)
    // Not zero percent. There is no margin on no sales, and 0% reads as a
    // catastrophic day rather than a closed one.
    expect(summary.marginBasisPoints).toBeNull()
    expect(summary.costCoverageBasisPoints).toBeNull()
  })

  it('adds up a plain day', () => {
    const summary = summariseSales([record(), record()])

    expect(summary.bills).toBe(2)
    expect(summary.covers).toBe(4)
    expect(summary.totalMinor).toBe(23_320)
    expect(summary.netSalesMinor).toBe(20_000)
    expect(summary.costMinor).toBe(6_000)
    expect(summary.grossProfitMinor).toBe(14_000)
    // 14000 / 20000 = 70%
    expect(summary.marginBasisPoints).toBe(7_000)
    expect(summary.averageBillMinor).toBe(11_660)
    expect(summary.averagePerCoverMinor).toBe(5_830)
  })

  it('takes the discount off net sales', () => {
    const summary = summariseSales([
      record({ discountMinor: 2_000, totalMinor: 9_328 }),
    ])

    expect(summary.netSalesMinor).toBe(8_000)
    expect(summary.grossProfitMinor).toBe(5_000)
  })

  it('keeps the cost of a refunded meal', () => {
    // The whole point. The food was cooked and is gone; refunding the
    // customer does not put the ingredients back on the shelf.
    const summary = summariseSales([
      record({ refundedMinor: 11_660 }),
    ])

    expect(summary.netSalesMinor).toBe(0)
    expect(summary.costMinor).toBe(3_000)
    // A refunded meal is a total loss, and the margin says so rather than
    // quietly reporting the sale as if it never happened.
    expect(summary.grossProfitMinor).toBe(-3_000)
    expect(summary.marginBasisPoints).toBeNull()
  })

  it('reduces tax and service proportionally on a part refund', () => {
    const summary = summariseSales([
      record({ refundedMinor: 5_830 }),
    ])

    // Half the bill came back, so half the tax collected on it did too.
    expect(summary.taxMinor).toBe(330)
    expect(summary.serviceChargeMinor).toBe(500)
    expect(summary.netSalesMinor).toBe(5_000)
  })

  it('ignores a refund larger than the bill rather than inventing negative sales', () => {
    const summary = summariseSales([
      record({ refundedMinor: 99_999 }),
    ])
    expect(summary.netSalesMinor).toBe(0)
  })

  it('reports how much of the menu is actually costed', () => {
    const summary = summariseSales([
      record({ costedSubtotalMinor: 10_000, costMinor: 3_000 }),
      record({ costedSubtotalMinor: 0, costMinor: 0 }),
    ])

    // Half the revenue has no recipe behind it, so the 85% margin below is a
    // margin on half the menu. Reporting coverage is what stops that number
    // being read as fact.
    expect(summary.costCoverageBasisPoints).toBe(5_000)
    expect(summary.marginBasisPoints).toBe(8_500)
  })

  it('reports no average per cover when nobody was counted', () => {
    const summary = summariseSales([record({ covers: 0 })])
    expect(summary.averagePerCoverMinor).toBe(0)
    expect(summary.averageBillMinor).toBe(11_660)
  })
})

describe('comparison', () => {
  it('reports growth in basis points', () => {
    expect(compare(11_000, 10_000).changeBasisPoints).toBe(1_000)
    expect(compare(9_000, 10_000).changeBasisPoints).toBe(-1_000)
    expect(compare(11_000, 10_000).changeMinor).toBe(1_000)
  })

  it('refuses to express growth from nothing', () => {
    // +100% would understate a first week of trading and overstate a single
    // sale. "No comparison" is the honest answer.
    expect(compare(50_000, 0).changeBasisPoints).toBeNull()
    expect(compare(0, 0).changeBasisPoints).toBeNull()
  })

  it('gives no ratio against a zero denominator', () => {
    expect(ratioBasisPoints(500, 0)).toBeNull()
    expect(ratioBasisPoints(500, 1_000)).toBe(5_000)
  })
})

describe('the shape of the day', () => {
  it('reads the hour in the restaurant’s zone', () => {
    const dinner = zonedTimeToInstant(KL, 2026, 8, 7, 19 * 60 + 30)
    const hours = distributeByHour([record({ settledAt: dinner })], KL)

    expect(hours).toHaveLength(24)
    expect(hours[19].bills).toBe(1)
    expect(hours[19].totalMinor).toBe(11_660)
    // The same instant read in UTC lands at 11:30, which would put the dinner
    // rush at lunchtime on every chart.
    expect(hours[11].bills).toBe(0)
  })

  it('keeps every hour, including the quiet ones', () => {
    const hours = distributeByHour([], KL)
    expect(hours).toHaveLength(24)
    // Unlike sales buckets: here a flat hour is the shape of the day, and the
    // gaps are what a manager is looking for.
    expect(hours.every((h) => h.bills === 0)).toBe(true)
  })
})
