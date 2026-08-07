import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
} from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  branches,
  menuCategories,
  menuItems,
  orderLines,
  paymentRefunds,
  payments,
  promotionRedemptions,
  salesRecords,
  sessionDiscounts,
  users,
} from '@/lib/db/schema'
import {
  bucketSales,
  compare,
  distributeByHour,
  previousRange,
  ratioBasisPoints,
  summariseSales,
  type Comparison,
  type Granularity,
  type HourBucket,
  type ReportRange,
  type SalesBucket,
  type SalesRecord,
  type SalesSummary,
} from './report'

/**
 * Reporting reads.
 *
 * Every figure here comes from `sales_records` — the snapshot written when a
 * bill was settled — rather than from recomputing bills against current
 * settings. See `src/lib/db/schema/reporting.ts` for why.
 *
 * One deliberate consequence, stated here because it is the kind of thing
 * that surprises an accountant: these reports are on a SALES basis. A refund
 * issued in September against an August meal reduces August, because that is
 * the month whose revenue was overstated. The Phase 7 takings report is on a
 * CASH basis and bounds everything by when money moved. Both are correct
 * answers to different questions, and the UI labels which is which.
 */

export interface ReportContext {
  restaurantId: string
  userId: string
  timeZone: string
  businessDayStartMinutes: number
}

export interface ReportFilters {
  range: ReportRange
  /** Null means every branch this restaurant has. */
  branchId?: string | null
}

function inRange(range: ReportRange) {
  return and(
    gte(salesRecords.settledAt, range.from),
    lt(salesRecords.settledAt, range.to),
  )
}

function scoped(filters: ReportFilters) {
  return filters.branchId
    ? and(inRange(filters.range), eq(salesRecords.branchId, filters.branchId))
    : inRange(filters.range)
}

interface LoadedRecord extends SalesRecord {
  id: string
  sessionId: string
  branchId: string
  type: 'dine_in' | 'takeaway' | 'delivery'
  taxRateBasisPoints: number
  taxIsIncluded: boolean
}

/**
 * Loads settled bills with what has since been refunded against them.
 *
 * One query with a left join and a group by, not two.
 *
 * The Phase 11 lesson applies in reverse here: joining two independent
 * one-to-many tables fans rows out and doubles a sum. Only ONE such table is
 * joined — refunds — so grouping by the record's primary key collapses the
 * fan-out exactly. Adding a second join to this statement would silently
 * inflate `refundedMinor`, which is why payments are loaded separately below.
 */
async function loadRecordsIn(
  tx: Transaction,
  filters: ReportFilters,
): Promise<LoadedRecord[]> {
  const rows = await tx
    .select({
      id: salesRecords.id,
      sessionId: salesRecords.sessionId,
      branchId: salesRecords.branchId,
      type: salesRecords.type,
      settledAt: salesRecords.settledAt,
      subtotalMinor: salesRecords.subtotalMinor,
      discountMinor: salesRecords.discountMinor,
      serviceChargeMinor: salesRecords.serviceChargeMinor,
      taxMinor: salesRecords.taxMinor,
      totalMinor: salesRecords.totalMinor,
      costMinor: salesRecords.costMinor,
      costedSubtotalMinor: salesRecords.costedSubtotalMinor,
      covers: salesRecords.covers,
      taxRateBasisPoints: salesRecords.taxRateBasisPoints,
      taxIsIncluded: salesRecords.taxIsIncluded,
      refundedMinor: sql<number>`coalesce(sum(${paymentRefunds.amountMinor}), 0)::int`,
    })
    .from(salesRecords)
    .leftJoin(
      paymentRefunds,
      eq(paymentRefunds.sessionId, salesRecords.sessionId),
    )
    .where(scoped(filters))
    .groupBy(salesRecords.id)
    .orderBy(desc(salesRecords.settledAt))

  return rows.map((row) => ({
    ...row,
    // Null covers means nobody was counted, which is not the same as a table
    // of zero people — but for arithmetic it contributes nothing either way.
    covers: row.covers ?? 0,
  }))
}

// --- sales ---

export interface BranchLine {
  branchId: string
  name: string
  code: string
  summary: SalesSummary
}

export interface MethodLine {
  method: string
  count: number
  amountMinor: number
}

export interface TypeLine {
  type: 'dine_in' | 'takeaway' | 'delivery'
  summary: SalesSummary
}

export interface SalesReport {
  range: ReportRange
  granularity: Granularity
  summary: SalesSummary
  /** The same length of time immediately before this one. */
  previous: SalesSummary
  netSales: Comparison
  bills: Comparison
  covers: Comparison
  series: SalesBucket[]
  byBranch: BranchLine[]
  byType: TypeLine[]
  byMethod: MethodLine[]
  byHour: HourBucket[]
}

/**
 * Payments taken against the bills in this report.
 *
 * Loaded in its own query rather than joined onto the records above. A bill
 * settled with cash and a card has two payment rows, and joining them into
 * the same statement as refunds would multiply one against the other.
 */
async function loadMethodsIn(
  tx: Transaction,
  sessionIds: readonly string[],
): Promise<MethodLine[]> {
  if (sessionIds.length === 0) return []

  const rows = await tx
    .select({
      method: payments.method,
      count: sql<number>`count(*)::int`,
      amountMinor: sql<number>`coalesce(sum(${payments.amountMinor}), 0)::int`,
    })
    .from(payments)
    .where(
      and(
        inArray(payments.sessionId, [...sessionIds]),
        eq(payments.status, 'succeeded'),
      ),
    )
    .groupBy(payments.method)

  return rows.sort((a, b) => b.amountMinor - a.amountMinor)
}

export async function readSalesReport(
  ctx: ReportContext,
  filters: ReportFilters,
  granularity: Granularity = 'day',
): Promise<SalesReport> {
  return withTenant(ctx, async (tx) => {
    const records = await loadRecordsIn(tx, filters)
    const before = await loadRecordsIn(tx, {
      ...filters,
      range: previousRange(filters.range),
    })

    const summary = summariseSales(records)
    const previous = summariseSales(before)

    const branchRows = await tx
      .select({
        id: branches.id,
        name: branches.name,
        code: branches.code,
      })
      .from(branches)
      .where(eq(branches.restaurantId, ctx.restaurantId))

    const byBranch: BranchLine[] = branchRows
      .map((branch) => ({
        branchId: branch.id,
        name: branch.name,
        code: branch.code,
        summary: summariseSales(
          records.filter((record) => record.branchId === branch.id),
        ),
      }))
      // A branch that took nothing is dropped rather than listed as a zero:
      // on a multi-branch account most of the list would otherwise be branches
      // that were simply closed that day.
      .filter((line) => line.summary.bills > 0)
      .sort((a, b) => b.summary.totalMinor - a.summary.totalMinor)

    const types: TypeLine['type'][] = ['dine_in', 'takeaway', 'delivery']
    const byType: TypeLine[] = types
      .map((type) => ({
        type,
        summary: summariseSales(
          records.filter((record) => record.type === type),
        ),
      }))
      .filter((line) => line.summary.bills > 0)

    return {
      range: filters.range,
      granularity,
      summary,
      previous,
      netSales: compare(summary.netSalesMinor, previous.netSalesMinor),
      bills: compare(summary.bills, previous.bills),
      covers: compare(summary.covers, previous.covers),
      series: bucketSales(
        records,
        granularity,
        ctx.timeZone,
        ctx.businessDayStartMinutes,
      ),
      byBranch,
      byType,
      byMethod: await loadMethodsIn(
        tx,
        records.map((record) => record.sessionId),
      ),
      byHour: distributeByHour(records, ctx.timeZone),
    }
  })
}

// --- items ---

export interface ItemLine {
  menuItemId: string | null
  name: string
  categoryName: string | null
  quantity: number
  revenueMinor: number
  costMinor: number
  grossProfitMinor: number
  marginBasisPoints: number | null
  /** False when nothing this item sold produced a stock movement. */
  isCosted: boolean
}

export interface ItemReport {
  range: ReportRange
  items: ItemLine[]
  categories: {
    categoryName: string
    quantity: number
    revenueMinor: number
    costMinor: number
  }[]
  /** Share of revenue on this report that has a recipe behind it. */
  costCoverageBasisPoints: number | null
}

/**
 * Item performance, with the cost of what each dish consumed.
 *
 * Revenue and cost are two separate queries merged in code. Joining stock
 * movements onto order lines in the revenue query would multiply each line
 * total by the number of ingredients in its recipe — a three-ingredient dish
 * would report three times its price, and the figure would still look
 * entirely plausible.
 *
 * Rows are keyed by the item's id AND the name it was sold under. A dish
 * renamed mid-period appears as two lines, which is the truthful answer: the
 * receipts say two different things and pretending otherwise loses the fact
 * that the change happened.
 */
export async function readItemReport(
  ctx: ReportContext,
  filters: ReportFilters,
): Promise<ItemReport> {
  return withTenant(ctx, async (tx) => {
    const sold = await tx
      .select({
        menuItemId: orderLines.menuItemId,
        name: orderLines.nameSnapshot,
        categoryName: menuCategories.name,
        quantity: sql<number>`coalesce(sum(${orderLines.quantity}), 0)::int`,
        revenueMinor: sql<number>`coalesce(sum(${orderLines.lineTotalMinor}), 0)::int`,
      })
      .from(orderLines)
      .innerJoin(
        salesRecords,
        eq(salesRecords.sessionId, orderLines.sessionId),
      )
      .leftJoin(menuItems, eq(menuItems.id, orderLines.menuItemId))
      .leftJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId))
      .where(and(scoped(filters), ne(orderLines.status, 'voided')))
      .groupBy(
        orderLines.menuItemId,
        orderLines.nameSnapshot,
        menuCategories.name,
      )

    /**
     * Cost comes from the line's own snapshot, not from the stock ledger.
     *
     * A consumption movement covers a whole order — one row per ingredient
     * rather than per line, so that concurrent orders lock ingredients in the
     * same sequence — which makes it unable to say which dish consumed what.
     * The line snapshots its cost when it is ordered, for the same reason it
     * snapshots its price.
     *
     * Still a second query rather than a column on the one above: a line with
     * no recipe must be distinguishable from one costing nothing, and that
     * needs a count of the costed lines, not just a sum that quietly treats
     * NULL as zero.
     */
    const costed = await tx
      .select({
        menuItemId: orderLines.menuItemId,
        name: orderLines.nameSnapshot,
        costMinor: sql<number>`coalesce(sum(${orderLines.costMinor}), 0)::int`,
      })
      .from(orderLines)
      .innerJoin(
        salesRecords,
        eq(salesRecords.sessionId, orderLines.sessionId),
      )
      .where(
        and(
          scoped(filters),
          ne(orderLines.status, 'voided'),
          isNotNull(orderLines.costMinor),
        ),
      )
      .groupBy(orderLines.menuItemId, orderLines.nameSnapshot)

    const key = (menuItemId: string | null, name: string): string =>
      `${menuItemId ?? ''}::${name}`

    const costByItem = new Map<string, number>()
    for (const row of costed) {
      costByItem.set(key(row.menuItemId, row.name), row.costMinor)
    }

    const items: ItemLine[] = sold
      .map((row) => {
        const itemKey = key(row.menuItemId, row.name)
        const isCosted = costByItem.has(itemKey)
        const costMinor = costByItem.get(itemKey) ?? 0
        const grossProfitMinor = row.revenueMinor - costMinor

        return {
          menuItemId: row.menuItemId,
          name: row.name,
          categoryName: row.categoryName,
          quantity: row.quantity,
          revenueMinor: row.revenueMinor,
          costMinor,
          grossProfitMinor,
          /**
           * No recipe means no cost, and a margin computed from a zero cost
           * would read as 100%. Null is the honest answer, and the flag is
           * what lets the UI say why.
           */
          marginBasisPoints: isCosted
            ? ratioBasisPoints(grossProfitMinor, row.revenueMinor)
            : null,
          isCosted,
        }
      })
      .sort((a, b) => b.revenueMinor - a.revenueMinor)

    const categories = new Map<
      string,
      { categoryName: string; quantity: number; revenueMinor: number; costMinor: number }
    >()

    for (const item of items) {
      const name = item.categoryName ?? 'Uncategorised'
      const existing = categories.get(name) ?? {
        categoryName: name,
        quantity: 0,
        revenueMinor: 0,
        costMinor: 0,
      }
      existing.quantity += item.quantity
      existing.revenueMinor += item.revenueMinor
      existing.costMinor += item.costMinor
      categories.set(name, existing)
    }

    const totalRevenue = items.reduce((sum, i) => sum + i.revenueMinor, 0)
    const costedRevenue = items
      .filter((i) => i.isCosted)
      .reduce((sum, i) => sum + i.revenueMinor, 0)

    return {
      range: filters.range,
      items,
      categories: [...categories.values()].sort(
        (a, b) => b.revenueMinor - a.revenueMinor,
      ),
      costCoverageBasisPoints: ratioBasisPoints(costedRevenue, totalRevenue),
    }
  })
}

// --- tax ---

export interface TaxLine {
  rateBasisPoints: number
  taxIsIncluded: boolean
  bills: number
  /** What the tax was charged on: net sales plus service charge. */
  taxableBaseMinor: number
  taxMinor: number
  serviceChargeMinor: number
}

export interface TaxReport {
  range: ReportRange
  lines: TaxLine[]
  totalTaxMinor: number
  totalTaxableMinor: number
}

/**
 * Tax collected, grouped by the rate that was actually in force.
 *
 * Grouped by the snapshotted rate rather than the current one, which is the
 * entire point of the snapshot: a period spanning a rate change reports two
 * lines, each with the tax genuinely charged under it. Recomputing would
 * report one line at whichever rate happens to be configured today, and would
 * change again the next time somebody edits the setting.
 */
export async function readTaxReport(
  ctx: ReportContext,
  filters: ReportFilters,
): Promise<TaxReport> {
  return withTenant(ctx, async (tx) => {
    const records = await loadRecordsIn(tx, filters)

    const grouped = new Map<string, LoadedRecord[]>()
    for (const record of records) {
      const groupKey = `${record.taxRateBasisPoints}:${record.taxIsIncluded}`
      const bucket = grouped.get(groupKey)
      if (bucket) bucket.push(record)
      else grouped.set(groupKey, [record])
    }

    const lines: TaxLine[] = [...grouped.values()]
      .map((bucket) => {
        const summary = summariseSales(bucket)
        return {
          rateBasisPoints: bucket[0].taxRateBasisPoints,
          taxIsIncluded: bucket[0].taxIsIncluded,
          bills: summary.bills,
          /**
           * Net sales plus service charge, because a service charge is itself
           * taxable in the jurisdictions this models — the same order of
           * operations `calculateBill` uses, so the two agree by construction.
           */
          taxableBaseMinor:
            summary.netSalesMinor + summary.serviceChargeMinor,
          taxMinor: summary.taxMinor,
          serviceChargeMinor: summary.serviceChargeMinor,
        }
      })
      .sort((a, b) => b.rateBasisPoints - a.rateBasisPoints)

    return {
      range: filters.range,
      lines,
      totalTaxMinor: lines.reduce((sum, line) => sum + line.taxMinor, 0),
      totalTaxableMinor: lines.reduce(
        (sum, line) => sum + line.taxableBaseMinor,
        0,
      ),
    }
  })
}

// --- what was given away ---

export interface LossReport {
  range: ReportRange
  /** Staff-applied comps and reductions. */
  manualDiscounts: {
    reason: string
    appliedBy: string | null
    count: number
    valueMinor: number
  }[]
  /** Rule-driven promotions and vouchers. */
  promotions: { name: string; count: number; valueMinor: number }[]
  voids: {
    name: string
    count: number
    valueMinor: number
    voidedBy: string | null
  }[]
  refundsMinor: number
  totalGivenAwayMinor: number
}

/**
 * What left the business without being paid for.
 *
 * Discounts, promotions, voids and refunds in one place, because separately
 * each looks like a rounding error and together they are often the difference
 * between a good month and a bad one. Named by who applied them, because the
 * pattern that matters is usually one person's.
 */
export async function readLossReport(
  ctx: ReportContext,
  filters: ReportFilters,
): Promise<LossReport> {
  return withTenant(ctx, async (tx) => {
    const manualRows = await tx
      .select({
        reason: sessionDiscounts.reason,
        appliedBy: users.name,
        count: sql<number>`count(*)::int`,
        /**
         * Percentage discounts are stored as basis points, not money, so they
         * cannot be summed here. Only fixed-value comps are totalled; the
         * count still shows the percentage ones exist.
         */
        valueMinor: sql<number>`coalesce(sum(case when ${sessionDiscounts.type} = 'fixed' then ${sessionDiscounts.value} else 0 end), 0)::int`,
      })
      .from(sessionDiscounts)
      .innerJoin(
        salesRecords,
        eq(salesRecords.sessionId, sessionDiscounts.sessionId),
      )
      .leftJoin(users, eq(users.id, sessionDiscounts.appliedByUserId))
      .where(and(scoped(filters), isNull(sessionDiscounts.removedAt)))
      .groupBy(sessionDiscounts.reason, users.name)

    const promotionRows = await tx
      .select({
        name: promotionRedemptions.nameSnapshot,
        count: sql<number>`count(*)::int`,
        valueMinor: sql<number>`coalesce(sum(${promotionRedemptions.discountMinor}), 0)::int`,
      })
      .from(promotionRedemptions)
      .innerJoin(
        salesRecords,
        eq(salesRecords.sessionId, promotionRedemptions.sessionId),
      )
      .where(scoped(filters))
      .groupBy(promotionRedemptions.nameSnapshot)

    const voidRows = await tx
      .select({
        name: orderLines.nameSnapshot,
        voidedBy: users.name,
        count: sql<number>`count(*)::int`,
        valueMinor: sql<number>`coalesce(sum(${orderLines.lineTotalMinor}), 0)::int`,
      })
      .from(orderLines)
      .innerJoin(
        salesRecords,
        eq(salesRecords.sessionId, orderLines.sessionId),
      )
      .leftJoin(users, eq(users.id, orderLines.voidedByUserId))
      .where(and(scoped(filters), eq(orderLines.status, 'voided')))
      .groupBy(orderLines.nameSnapshot, users.name)

    const [refunded] = await tx
      .select({
        amountMinor: sql<number>`coalesce(sum(${paymentRefunds.amountMinor}), 0)::int`,
      })
      .from(paymentRefunds)
      .innerJoin(
        salesRecords,
        eq(salesRecords.sessionId, paymentRefunds.sessionId),
      )
      .where(scoped(filters))

    const byValue = <T extends { valueMinor: number }>(a: T, b: T): number =>
      b.valueMinor - a.valueMinor

    const manualDiscounts = manualRows.sort(byValue)
    const promotions = promotionRows.sort(byValue)
    const voids = voidRows.sort(byValue)
    const refundsMinor = refunded?.amountMinor ?? 0

    const sumOf = (rows: readonly { valueMinor: number }[]): number =>
      rows.reduce((total, row) => total + row.valueMinor, 0)

    return {
      range: filters.range,
      manualDiscounts,
      promotions,
      voids,
      refundsMinor,
      totalGivenAwayMinor:
        sumOf(manualDiscounts) +
        sumOf(promotions) +
        sumOf(voids) +
        refundsMinor,
    }
  })
}
