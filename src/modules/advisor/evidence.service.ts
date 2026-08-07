import { and, eq, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  customers,
  diningSessions,
  ingredients,
  kitchenStations,
  loyaltyTransactions,
  menuItems,
  orderLines,
  payments,
  recipeComponents,
  salesRecords,
  stockLevels,
  stockMovements,
  suppliers,
  users,
} from '@/lib/db/schema'
import { previousRange, type ReportRange } from '@/modules/reporting/report'
import { readItemReport, type ReportContext } from '@/modules/reporting/report.service'
import { readSalesReport } from '@/modules/reporting/report.service'
import type {
  AdvisorSnapshot,
  AtRiskCustomer,
  CostDriftFacts,
  StationFacts,
  StockFacts,
  VoidFacts,
  WastageFacts,
} from './insights'

/**
 * Gathering what the advisor reasons over.
 *
 * This module reads; it decides nothing. Every threshold, comparison and
 * conclusion lives in `insights.ts`, which is pure and exhaustively tested.
 * The split is the point: the part that can be got wrong quietly is the part
 * that never touches a database.
 *
 * Where a figure already exists in the Phase 12 reports, it is read from
 * there rather than recomputed — so the advisor and the reports page can never
 * disagree about the same number in front of the same person.
 */

/** A day, in milliseconds. */
const DAY = 24 * 60 * 60_000

/**
 * The share of net sales a restaurant expects to spend on ingredients.
 *
 * A constant rather than a setting, for now. 35% is the conventional
 * full-service figure; a bar runs far below it and a steakhouse above. Making
 * it configurable before anyone has disagreed with it would be a settings
 * field nobody opens, and it is one column when they do.
 */
export const DEFAULT_TARGET_FOOD_COST_BASIS_POINTS = 3_500

function daysBetween(range: ReportRange): number {
  return Math.max(
    1,
    Math.round((range.to.getTime() - range.from.getTime()) / DAY),
  )
}

/** Bills in the period that carried a member, for judging loyalty capture. */
async function countCapturedBillsIn(
  tx: Transaction,
  restaurantId: string,
  range: ReportRange,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(salesRecords)
    .where(
      and(
        eq(salesRecords.restaurantId, restaurantId),
        gte(salesRecords.settledAt, range.from),
        lt(salesRecords.settledAt, range.to),
        isNotNull(salesRecords.customerId),
      ),
    )

  return row?.count ?? 0
}

async function readStockIn(
  tx: Transaction,
  restaurantId: string,
): Promise<StockFacts[]> {
  const rows = await tx
    .select({
      ingredientId: ingredients.id,
      name: ingredients.name,
      unit: ingredients.unit,
      onHandMilli: stockLevels.quantityMilli,
      reorderPointMilli: ingredients.reorderPointMilli,
      reorderQuantityMilli: ingredients.reorderQuantityMilli,
      supplierName: suppliers.name,
      lastCountedAt: stockLevels.lastCountedAt,
    })
    .from(stockLevels)
    .innerJoin(ingredients, eq(ingredients.id, stockLevels.ingredientId))
    .leftJoin(suppliers, eq(suppliers.id, ingredients.preferredSupplierId))
    .where(
      and(
        eq(stockLevels.restaurantId, restaurantId),
        eq(ingredients.isActive, true),
      ),
    )

  return rows.map((row) => ({
    ingredientId: row.ingredientId,
    name: row.name,
    unit: row.unit,
    onHandMilli: row.onHandMilli,
    reorderPointMilli: row.reorderPointMilli,
    reorderQuantityMilli: row.reorderQuantityMilli,
    supplierName: row.supplierName,
    neverCounted: row.lastCountedAt === null,
  }))
}

/**
 * Wastage against consumption, over the period.
 *
 * Two aggregates from one table, so a single grouped query with conditional
 * sums rather than two queries merged in code. There is no join here to fan
 * rows out, which is the condition under which that shortcut is safe.
 */
async function readWastageIn(
  tx: Transaction,
  restaurantId: string,
  range: ReportRange,
): Promise<WastageFacts[]> {
  const rows = await tx
    .select({
      ingredientId: ingredients.id,
      name: ingredients.name,
      unit: ingredients.unit,
      wastedMilli: sql<number>`coalesce(-sum(case when ${stockMovements.kind} = 'wastage' then ${stockMovements.quantityMilli} else 0 end), 0)::int`,
      consumedMilli: sql<number>`coalesce(-sum(case when ${stockMovements.kind} = 'consumption' then ${stockMovements.quantityMilli} else 0 end), 0)::int`,
      wastedValueMinor: sql<number>`coalesce(-sum(case when ${stockMovements.kind} = 'wastage' then ${stockMovements.valueMinor} else 0 end), 0)::int`,
    })
    .from(stockMovements)
    .innerJoin(ingredients, eq(ingredients.id, stockMovements.ingredientId))
    .where(
      and(
        eq(stockMovements.restaurantId, restaurantId),
        gte(stockMovements.createdAt, range.from),
        lt(stockMovements.createdAt, range.to),
        inArray(stockMovements.kind, ['wastage', 'consumption']),
      ),
    )
    .groupBy(ingredients.id, ingredients.name, ingredients.unit)

  return rows.filter((row) => row.wastedMilli > 0)
}

/**
 * Ingredients whose held cost has moved during the period.
 *
 * The "before" figure comes from the cost snapshotted onto the earliest
 * movement in the window, not from a historical cost column that does not
 * exist. Phase 10 froze that value onto every movement precisely so a past
 * period's costs would stop moving, and this is the first thing to read it
 * back.
 */
async function readCostDriftIn(
  tx: Transaction,
  restaurantId: string,
  range: ReportRange,
): Promise<CostDriftFacts[]> {
  const rows = await tx
    .select({
      ingredientId: ingredients.id,
      name: ingredients.name,
      unit: ingredients.unit,
      currentCostPerUnitMinor: ingredients.costPerUnitMinor,
      /**
       * `distinct on` would be neater and is not portable through Drizzle's
       * builder; ordering inside an aggregate gets the same first value.
       */
      previousCostPerUnitMinor: sql<number>`(array_agg(${stockMovements.costPerUnitMinor} order by ${stockMovements.createdAt}))[1]::int`,
    })
    .from(stockMovements)
    .innerJoin(ingredients, eq(ingredients.id, stockMovements.ingredientId))
    .where(
      and(
        eq(stockMovements.restaurantId, restaurantId),
        gte(stockMovements.createdAt, range.from),
        lt(stockMovements.createdAt, range.to),
        sql`${stockMovements.costPerUnitMinor} > 0`,
      ),
    )
    .groupBy(ingredients.id, ingredients.name, ingredients.unit)

  const moved = rows.filter(
    (row) => row.currentCostPerUnitMinor > row.previousCostPerUnitMinor,
  )

  if (moved.length === 0) return []

  /**
   * Which dishes each moved ingredient thins. A separate query rather than a
   * join onto the aggregate above, which would multiply each ingredient row by
   * the number of recipes using it and corrupt the cost figures.
   */
  const uses = await tx
    .select({
      ingredientId: recipeComponents.ingredientId,
      itemName: menuItems.name,
    })
    .from(recipeComponents)
    .innerJoin(menuItems, eq(menuItems.id, recipeComponents.menuItemId))
    .where(
      and(
        eq(recipeComponents.restaurantId, restaurantId),
        inArray(
          recipeComponents.ingredientId,
          moved.map((row) => row.ingredientId),
        ),
      ),
    )

  const itemsByIngredient = new Map<string, string[]>()
  for (const use of uses) {
    const list = itemsByIngredient.get(use.ingredientId) ?? []
    list.push(use.itemName)
    itemsByIngredient.set(use.ingredientId, list)
  }

  return moved.map((row) => ({
    ingredientId: row.ingredientId,
    name: row.name,
    unit: row.unit,
    previousCostPerUnitMinor: row.previousCostPerUnitMinor,
    currentCostPerUnitMinor: row.currentCostPerUnitMinor,
    affectedItems: itemsByIngredient.get(row.ingredientId) ?? [],
  }))
}

/**
 * Median preparation time per station.
 *
 * The median, computed in Postgres, rather than a mean computed in JavaScript.
 * One ticket left open across a shift change adds four hours to a mean and
 * makes an otherwise fine station look broken; the median shrugs it off.
 *
 * Only tickets that were both started and finished count. An unfinished one
 * has no duration, and treating "not finished yet" as "took until now" makes
 * the number grow while it is being read.
 */
async function readStationsIn(
  tx: Transaction,
  restaurantId: string,
  range: ReportRange,
): Promise<StationFacts[]> {
  const rows = await tx
    .select({
      stationId: kitchenStations.id,
      name: kitchenStations.name,
      tickets: sql<number>`count(*)::int`,
      medianPrepMinutes: sql<number>`coalesce(round(percentile_cont(0.5) within group (order by extract(epoch from (${orderLines.readyAt} - ${orderLines.startedAt})) / 60)), 0)::int`,
    })
    .from(orderLines)
    .innerJoin(
      kitchenStations,
      eq(kitchenStations.id, orderLines.kitchenStationId),
    )
    .where(
      and(
        eq(orderLines.restaurantId, restaurantId),
        gte(orderLines.placedAt, range.from),
        lt(orderLines.placedAt, range.to),
        isNotNull(orderLines.startedAt),
        isNotNull(orderLines.readyAt),
      ),
    )
    .groupBy(kitchenStations.id, kitchenStations.name)

  return rows
}

async function readVoidsIn(
  tx: Transaction,
  restaurantId: string,
  range: ReportRange,
): Promise<VoidFacts[]> {
  const rows = await tx
    .select({
      userId: orderLines.voidedByUserId,
      name: users.name,
      count: sql<number>`count(*)::int`,
      valueMinor: sql<number>`coalesce(sum(${orderLines.lineTotalMinor}), 0)::int`,
    })
    .from(orderLines)
    .leftJoin(users, eq(users.id, orderLines.voidedByUserId))
    .where(
      and(
        eq(orderLines.restaurantId, restaurantId),
        eq(orderLines.status, 'voided'),
        gte(orderLines.placedAt, range.from),
        lt(orderLines.placedAt, range.to),
      ),
    )
    .groupBy(orderLines.voidedByUserId, users.name)

  return rows.map((row) => ({
    userId: row.userId,
    name: row.name ?? 'Unattributed',
    count: row.count,
    valueMinor: row.valueMinor,
  }))
}

/**
 * Regulars who are overdue against their own rhythm.
 *
 * "Overdue" is measured per customer, not against a fixed number of days.
 * Someone who eats here weekly is worth chasing after three weeks; someone who
 * comes at Christmas is not late in February, and a fixed threshold cannot
 * tell them apart.
 *
 * Two visits is the floor. One visit gives no gap at all, and a rhythm
 * inferred from a single interval is a coincidence — the engine still reports
 * it and marks the confidence low.
 */
async function readAtRiskCustomersIn(
  tx: Transaction,
  restaurantId: string,
  now: Date,
): Promise<AtRiskCustomer[]> {
  const rows = await tx
    .select({
      customerId: customers.id,
      name: customers.name,
      visits: sql<number>`count(*)::int`,
      firstVisit: sql<Date>`min(${diningSessions.closedAt})`.mapWith(
        diningSessions.closedAt,
      ),
      lastVisit: sql<Date>`max(${diningSessions.closedAt})`.mapWith(
        diningSessions.closedAt,
      ),
    })
    .from(diningSessions)
    .innerJoin(customers, eq(customers.id, diningSessions.customerId))
    .where(
      and(
        eq(diningSessions.restaurantId, restaurantId),
        eq(diningSessions.status, 'closed'),
        isNotNull(diningSessions.closedAt),
      ),
    )
    .groupBy(customers.id, customers.name)
    .having(sql`count(*) >= 2`)

  if (rows.length === 0) return []

  const spend = await tx
    .select({
      customerId: salesRecords.customerId,
      lifetimeSpendMinor: sql<number>`coalesce(sum(${salesRecords.paidMinor}), 0)::int`,
    })
    .from(salesRecords)
    .where(
      and(
        eq(salesRecords.restaurantId, restaurantId),
        inArray(
          salesRecords.customerId,
          rows.map((row) => row.customerId),
        ),
      ),
    )
    .groupBy(salesRecords.customerId)

  const spendByCustomer = new Map(
    spend.map((row) => [row.customerId, row.lifetimeSpendMinor]),
  )

  const atRisk: AtRiskCustomer[] = []

  for (const row of rows) {
    const span = row.lastVisit.getTime() - row.firstVisit.getTime()
    const typicalGapDays = Math.max(1, Math.round(span / DAY / (row.visits - 1)))
    const daysSinceVisit = Math.floor(
      (now.getTime() - row.lastVisit.getTime()) / DAY,
    )

    // Twice their own usual gap. One missed visit is a busy fortnight.
    if (daysSinceVisit < typicalGapDays * 2) continue

    atRisk.push({
      customerId: row.customerId,
      name: row.name,
      daysSinceVisit,
      typicalGapDays,
      visits: row.visits,
      lifetimeSpendMinor: spendByCustomer.get(row.customerId) ?? 0,
    })
  }

  return atRisk
    .sort((a, b) => b.lifetimeSpendMinor - a.lifetimeSpendMinor)
    .slice(0, 10)
}

async function readLoyaltyIn(
  tx: Transaction,
  restaurantId: string,
  range: ReportRange,
): Promise<{ outstanding: number; earnedThisPeriod: number }> {
  const [balance] = await tx
    .select({
      outstanding: sql<number>`coalesce(sum(${loyaltyTransactions.points}), 0)::int`,
    })
    .from(loyaltyTransactions)
    .where(eq(loyaltyTransactions.restaurantId, restaurantId))

  const [earned] = await tx
    .select({
      points: sql<number>`coalesce(sum(case when ${loyaltyTransactions.points} > 0 then ${loyaltyTransactions.points} else 0 end), 0)::int`,
    })
    .from(loyaltyTransactions)
    .where(
      and(
        eq(loyaltyTransactions.restaurantId, restaurantId),
        gte(loyaltyTransactions.createdAt, range.from),
        lt(loyaltyTransactions.createdAt, range.to),
      ),
    )

  return {
    outstanding: Math.max(0, balance?.outstanding ?? 0),
    earnedThisPeriod: earned?.points ?? 0,
  }
}

async function countActiveCustomersIn(
  tx: Transaction,
  restaurantId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(customers)
    // There is no active flag on a customer, and nor should there be: a
    // member who stops coming is the subject of the at-risk finding below,
    // not a row to be quietly excluded from the count that raises it.
    .where(eq(customers.restaurantId, restaurantId))

  return row?.count ?? 0
}

/** Units sold per item in the preceding period, for spotting a decline. */
async function readPreviousQuantitiesIn(
  tx: Transaction,
  restaurantId: string,
  range: ReportRange,
): Promise<Record<string, number>> {
  const before = previousRange(range)

  const rows = await tx
    .select({
      name: orderLines.nameSnapshot,
      quantity: sql<number>`coalesce(sum(${orderLines.quantity}), 0)::int`,
    })
    .from(orderLines)
    .innerJoin(salesRecords, eq(salesRecords.sessionId, orderLines.sessionId))
    .where(
      and(
        eq(salesRecords.restaurantId, restaurantId),
        gte(salesRecords.settledAt, before.from),
        lt(salesRecords.settledAt, before.to),
        ne(orderLines.status, 'voided'),
      ),
    )
    .groupBy(orderLines.nameSnapshot)

  return Object.fromEntries(rows.map((row) => [row.name, row.quantity]))
}

/**
 * Cash as a share of what was taken.
 *
 * Null when nothing was taken at all, rather than zero — "no payments" and
 * "no cash payments" are different facts and only one of them is a finding.
 */
async function readCashShareIn(
  tx: Transaction,
  restaurantId: string,
  range: ReportRange,
): Promise<number | null> {
  const [row] = await tx
    .select({
      total: sql<number>`coalesce(sum(${payments.amountMinor}), 0)::int`,
      cash: sql<number>`coalesce(sum(case when ${payments.method} = 'cash' then ${payments.amountMinor} else 0 end), 0)::int`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.restaurantId, restaurantId),
        eq(payments.status, 'succeeded'),
        gte(payments.takenAt, range.from),
        lt(payments.takenAt, range.to),
      ),
    )

  if (!row || row.total === 0) return null
  return Math.round((row.cash * 10_000) / row.total)
}

/**
 * Assembles everything the engine reasons over.
 *
 * The sales and menu figures come from the Phase 12 reports rather than fresh
 * queries. Two code paths computing "net sales" is two chances to disagree,
 * and the advisor contradicting the reports page in front of the same person
 * is the fastest way to make both untrusted.
 */
export async function gatherEvidence(
  ctx: ReportContext,
  range: ReportRange,
  branchId: string | null = null,
  now: Date = new Date(),
): Promise<AdvisorSnapshot> {
  const filters = { range, branchId }

  const [sales, items] = await Promise.all([
    readSalesReport(ctx, filters, 'day'),
    readItemReport(ctx, filters),
  ])

  return withTenant(ctx, async (tx) => {
    const [
      billsWithCustomer,
      stock,
      wastage,
      costDrift,
      stations,
      voids,
      atRiskCustomers,
      loyalty,
      activeCustomers,
      previousMenuQuantities,
      cashShareBasisPoints,
    ] = await Promise.all([
      countCapturedBillsIn(tx, ctx.restaurantId, range),
      readStockIn(tx, ctx.restaurantId),
      readWastageIn(tx, ctx.restaurantId, range),
      readCostDriftIn(tx, ctx.restaurantId, range),
      readStationsIn(tx, ctx.restaurantId, range),
      readVoidsIn(tx, ctx.restaurantId, range),
      readAtRiskCustomersIn(tx, ctx.restaurantId, now),
      readLoyaltyIn(tx, ctx.restaurantId, range),
      countActiveCustomersIn(tx, ctx.restaurantId),
      readPreviousQuantitiesIn(tx, ctx.restaurantId, range),
      readCashShareIn(tx, ctx.restaurantId, range),
    ])

    return {
      periodDays: daysBetween(range),
      sales: {
        bills: sales.summary.bills,
        covers: sales.summary.covers,
        netSalesMinor: sales.summary.netSalesMinor,
        costMinor: sales.summary.costMinor,
        discountMinor: sales.summary.discountMinor,
        grossProfitMinor: sales.summary.grossProfitMinor,
        marginBasisPoints: sales.summary.marginBasisPoints,
        costCoverageBasisPoints: sales.summary.costCoverageBasisPoints,
        previousBills: sales.previous.bills,
        previousNetSalesMinor: sales.previous.netSalesMinor,
        previousDiscountMinor: sales.previous.discountMinor,
        billsWithCustomer,
      },
      menu: items.items.map((item) => ({
        menuItemId: item.menuItemId,
        name: item.name,
        categoryName: item.categoryName,
        quantity: item.quantity,
        revenueMinor: item.revenueMinor,
        costMinor: item.costMinor,
        isCosted: item.isCosted,
      })),
      previousMenuQuantities,
      stock,
      wastage,
      costDrift,
      stations,
      voids,
      atRiskCustomers,
      pointsOutstanding: loyalty.outstanding,
      pointsEarnedThisPeriod: loyalty.earnedThisPeriod,
      activeCustomers,
      targetFoodCostBasisPoints: DEFAULT_TARGET_FOOD_COST_BASIS_POINTS,
      cashShareBasisPoints,
    }
  })
}
