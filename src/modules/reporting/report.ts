import {
  addCalendarDays,
  formatCalendarDate,
  parseIsoDate,
  zonedPartsOf,
  zonedTimeToInstant,
  type CalendarDate,
} from '@/lib/time'

/**
 * The reporting engine.
 *
 * Pure, like the bill, split, settlement, promotion and stock engines before
 * it. A report is an argument about money made to a bank, an accountant or a
 * tax authority, so the arithmetic behind it has to be exhaustively testable
 * without a database, a tenant or a clock.
 *
 * Everything is integer minor units. Rates and margins are integer basis
 * points, for the same reason bills are: a margin computed in floating point
 * and rounded for display is a number nobody can reproduce.
 */

export type Granularity = 'day' | 'week' | 'month'

/** Half-open: `from` inclusive, `to` exclusive. */
export interface ReportRange {
  from: Date
  to: Date
}

/**
 * When the trading day begins, in minutes past local midnight.
 *
 * A bar that closes at 02:00 does not have two trading days either side of
 * midnight; it has one night. Reporting it as two splits a single service in
 * half and makes both halves look like a bad night. Capped below 12 hours,
 * because a start past midday no longer names the day it belongs to.
 */
export const MAX_BUSINESS_DAY_START_MINUTES = 719

export function clampBusinessDayStart(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0
  return Math.min(
    MAX_BUSINESS_DAY_START_MINUTES,
    Math.max(0, Math.trunc(minutes)),
  )
}

/**
 * Which business day an instant belongs to, as `YYYY-MM-DD`.
 *
 * Decided from the wall clock in the restaurant's own zone and then rolled
 * back if it falls before the day's start — not by subtracting the offset from
 * the instant, which drifts by an hour across a daylight-saving boundary and
 * would move a handful of bills into the wrong night once or twice a year.
 */
export function businessDayOf(
  at: Date,
  timeZone: string,
  startMinutes = 0,
): string {
  const start = clampBusinessDayStart(startMinutes)
  const parts = zonedPartsOf(at, timeZone)
  const minutesIntoDay = parts.hour * 60 + parts.minute

  const date: CalendarDate = {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  }

  return formatCalendarDate(
    minutesIntoDay < start ? addCalendarDays(date, -1) : date,
  )
}

/**
 * The instants bounding one or more business days.
 *
 * `toIsoDate` is inclusive of the day named, because a manager asking for
 * "1st to 7th" means seven days. Half-open ranges are correct in code and
 * confusing in a date picker, so the conversion happens here rather than in
 * every caller.
 */
export function businessDayRange(
  fromIsoDate: string,
  toIsoDate: string,
  timeZone: string,
  startMinutes = 0,
): ReportRange | null {
  const start = clampBusinessDayStart(startMinutes)
  const fromDate = parseIsoDate(fromIsoDate)
  const toDate = parseIsoDate(toIsoDate)
  if (!fromDate || !toDate) return null

  const from = zonedTimeToInstant(
    timeZone,
    fromDate.year,
    fromDate.month,
    fromDate.day,
    start,
  )

  const dayAfter = addCalendarDays(toDate, 1)
  const to = zonedTimeToInstant(
    timeZone,
    dayAfter.year,
    dayAfter.month,
    dayAfter.day,
    start,
  )

  if (to <= from) return null
  return { from, to }
}

/** The business day an instant falls in, as a range. */
export function todayRange(
  now: Date,
  timeZone: string,
  startMinutes = 0,
): ReportRange {
  const today = businessDayOf(now, timeZone, startMinutes)
  // `businessDayOf` only ever emits a well-formed date, so the range is never
  // null here — but the non-null assertion is spelled out rather than assumed.
  const range = businessDayRange(today, today, timeZone, startMinutes)
  if (!range) throw new Error(`Unreachable: bad business day ${today}`)
  return range
}

/**
 * The equivalent range one period earlier, for comparison.
 *
 * Shifted by the range's own length rather than by a calendar month, so
 * "last 7 days" compares against the 7 days before it and a single day
 * compares against the day before. Comparing a 31-day month against a 28-day
 * one is how a February that traded well gets reported as a collapse.
 */
export function previousRange(range: ReportRange): ReportRange {
  const span = range.to.getTime() - range.from.getTime()
  return {
    from: new Date(range.from.getTime() - span),
    to: new Date(range.to.getTime() - span),
  }
}

/**
 * The bucket key an instant falls in.
 *
 * Weeks are keyed by the Monday that starts them, months by `YYYY-MM`. Both
 * are computed from the business day rather than the raw instant, so a bill
 * paid at 01:00 on Monday belongs to the week whose trade it was part of.
 */
export function bucketKeyOf(
  at: Date,
  granularity: Granularity,
  timeZone: string,
  startMinutes = 0,
): string {
  const day = businessDayOf(at, timeZone, startMinutes)
  if (granularity === 'day') return day

  const date = parseIsoDate(day)
  if (!date) return day

  if (granularity === 'month') {
    return day.slice(0, 7)
  }

  // Monday-based. `Date.UTC` gives 0 for Sunday, which is 6 days into the
  // week rather than the start of one.
  const weekday = new Date(
    Date.UTC(date.year, date.month - 1, date.day),
  ).getUTCDay()
  const backToMonday = weekday === 0 ? 6 : weekday - 1

  return formatCalendarDate(addCalendarDays(date, -backToMonday))
}

/**
 * One settled bill, as reporting sees it.
 *
 * Deliberately not the live session: these are the figures snapshotted when
 * the bill was settled. See `docs/phase-12/README.md` for why a report that
 * recomputes history is a report that changes after it is filed.
 */
export interface SalesRecord {
  settledAt: Date
  subtotalMinor: number
  discountMinor: number
  serviceChargeMinor: number
  taxMinor: number
  totalMinor: number
  refundedMinor: number
  /** Cost of what was consumed, from the stock ledger. */
  costMinor: number
  /**
   * The portion of the subtotal made up of items that actually have a recipe.
   *
   * Without this, margin silently means "margin on the dishes somebody got
   * round to costing", and a menu that is 20% costed reports a 95% margin.
   */
  costedSubtotalMinor: number
  covers: number
}

export interface SalesSummary {
  bills: number
  covers: number

  subtotalMinor: number
  discountMinor: number
  serviceChargeMinor: number
  taxMinor: number
  totalMinor: number
  refundedMinor: number

  /** Revenue excluding tax and service charge, less the refunded share. */
  netSalesMinor: number
  costMinor: number
  grossProfitMinor: number

  /** Gross profit over net sales. Null when there were no net sales. */
  marginBasisPoints: number | null
  /**
   * How much of the subtotal has a recipe behind it. Null when nothing sold.
   * A margin quoted against low coverage is a guess, and the UI says so.
   */
  costCoverageBasisPoints: number | null

  averageBillMinor: number
  averagePerCoverMinor: number
}

/** Integer basis points of `part` in `whole`; null when `whole` is zero. */
export function ratioBasisPoints(
  part: number,
  whole: number,
): number | null {
  if (whole === 0) return null
  return Math.round((part * 10_000) / whole)
}

/**
 * The share of a bill that was refunded, clamped to the whole.
 *
 * A refund exceeding the bill would otherwise produce negative sales, which
 * is not a thing that happened — it is an over-refund, and the refund path
 * already refuses one.
 */
function refundRatio(record: SalesRecord): number {
  if (record.totalMinor <= 0 || record.refundedMinor <= 0) return 0
  return Math.min(1, record.refundedMinor / record.totalMinor)
}

const EMPTY: SalesSummary = {
  bills: 0,
  covers: 0,
  subtotalMinor: 0,
  discountMinor: 0,
  serviceChargeMinor: 0,
  taxMinor: 0,
  totalMinor: 0,
  refundedMinor: 0,
  netSalesMinor: 0,
  costMinor: 0,
  grossProfitMinor: 0,
  marginBasisPoints: null,
  costCoverageBasisPoints: null,
  averageBillMinor: 0,
  averagePerCoverMinor: 0,
}

/**
 * Summarises settled bills.
 *
 * A refund reduces revenue but NOT cost. The food was cooked, plated and is
 * gone; refunding the customer does not put the ingredients back on the shelf.
 * Treating a refund as cancelling the sale entirely would leave a fully
 * refunded meal showing a healthy margin, which is exactly backwards — a
 * refunded meal is a total loss, and this arithmetic says so.
 *
 * Tax and service charge are reduced proportionally, because a refund does
 * return the tax collected on what was refunded.
 */
export function summariseSales(
  records: readonly SalesRecord[],
): SalesSummary {
  if (records.length === 0) return { ...EMPTY }

  let covers = 0
  let subtotalMinor = 0
  let discountMinor = 0
  let serviceChargeMinor = 0
  let taxMinor = 0
  let totalMinor = 0
  let refundedMinor = 0
  let netSalesMinor = 0
  let costMinor = 0
  let costedSubtotalMinor = 0

  for (const record of records) {
    const kept = 1 - refundRatio(record)

    covers += record.covers
    subtotalMinor += record.subtotalMinor
    discountMinor += record.discountMinor
    totalMinor += record.totalMinor
    refundedMinor += record.refundedMinor
    costMinor += record.costMinor
    costedSubtotalMinor += record.costedSubtotalMinor

    serviceChargeMinor += Math.round(record.serviceChargeMinor * kept)
    taxMinor += Math.round(record.taxMinor * kept)
    netSalesMinor += Math.round(
      (record.subtotalMinor - record.discountMinor) * kept,
    )
  }

  const grossProfitMinor = netSalesMinor - costMinor

  return {
    bills: records.length,
    covers,
    subtotalMinor,
    discountMinor,
    serviceChargeMinor,
    taxMinor,
    totalMinor,
    refundedMinor,
    netSalesMinor,
    costMinor,
    grossProfitMinor,
    marginBasisPoints: ratioBasisPoints(grossProfitMinor, netSalesMinor),
    costCoverageBasisPoints: ratioBasisPoints(
      costedSubtotalMinor,
      subtotalMinor,
    ),
    averageBillMinor: Math.round(totalMinor / records.length),
    averagePerCoverMinor: covers > 0 ? Math.round(totalMinor / covers) : 0,
  }
}

export interface SalesBucket {
  key: string
  summary: SalesSummary
}

/**
 * Groups bills into buckets and summarises each.
 *
 * Buckets with no trade are absent rather than zero. A chart that draws a
 * closing day as a zero looks like a catastrophe; the caller knows its own
 * opening hours and can decide whether a gap means shut or means nothing sold.
 */
export function bucketSales(
  records: readonly SalesRecord[],
  granularity: Granularity,
  timeZone: string,
  startMinutes = 0,
): SalesBucket[] {
  const grouped = new Map<string, SalesRecord[]>()

  for (const record of records) {
    const key = bucketKeyOf(
      record.settledAt,
      granularity,
      timeZone,
      startMinutes,
    )
    const bucket = grouped.get(key)
    if (bucket) bucket.push(record)
    else grouped.set(key, [record])
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, bucketRecords]) => ({
      key,
      summary: summariseSales(bucketRecords),
    }))
}

export interface Comparison {
  currentMinor: number
  previousMinor: number
  changeMinor: number
  /**
   * Null when the previous period was zero.
   *
   * Growth from nothing has no percentage. Rendering it as +100% understates
   * a first week of trading and overstates a single sale; showing "no
   * comparison" is the honest answer to a question with no answer.
   */
  changeBasisPoints: number | null
}

export function compare(
  currentMinor: number,
  previousMinor: number,
): Comparison {
  return {
    currentMinor,
    previousMinor,
    changeMinor: currentMinor - previousMinor,
    changeBasisPoints:
      previousMinor === 0
        ? null
        : Math.round(
            ((currentMinor - previousMinor) * 10_000) / Math.abs(previousMinor),
          ),
  }
}

/**
 * Distribution of trade across the hours of the day.
 *
 * Read in the restaurant's zone, so the evening rush appears in the evening.
 * All 24 hours are present, unlike sales buckets: a flat hour is meaningful
 * here — it is the shape of the day, and the gaps are the point.
 */
export interface HourBucket {
  hour: number
  bills: number
  totalMinor: number
}

export function distributeByHour(
  records: readonly SalesRecord[],
  timeZone: string,
): HourBucket[] {
  const hours: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    bills: 0,
    totalMinor: 0,
  }))

  for (const record of records) {
    const { hour } = zonedPartsOf(record.settledAt, timeZone)
    const bucket = hours[hour]
    if (!bucket) continue
    bucket.bills += 1
    bucket.totalMinor += record.totalMinor
  }

  return hours
}

/**
 * A label for a range, as it should appear on a printed report.
 *
 * Both ends are named as *business* days, not calendar days. With a 04:00
 * start the range for the 7th ends at 04:00 on the 8th, and labelling that
 * end by its calendar date would print "7 to 8" for a single night.
 */
export function describeRange(
  range: ReportRange,
  timeZone: string,
  startMinutes = 0,
): string {
  const from = businessDayOf(range.from, timeZone, startMinutes)
  // `to` is exclusive, so the last day included is the instant just before it.
  const to = businessDayOf(
    new Date(range.to.getTime() - 1),
    timeZone,
    startMinutes,
  )
  return from === to ? from : `${from} to ${to}`
}
