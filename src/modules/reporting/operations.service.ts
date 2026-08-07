import { and, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import { withTenant, type Transaction } from '@/lib/db'
import {
  attendanceRecords,
  diningSessions,
  ingredients,
  orderLines,
  reservations,
  salesRecords,
  serviceRequests,
  stockLevels,
  waitlistEntries,
} from '@/lib/db/schema'
import { summariseSales, todayRange } from './report'
import type { ReportContext } from './report.service'

/**
 * The live operations readout.
 *
 * Answers the question a manager walking through the door actually has:
 * what is happening right now, and is anything wrong. Everything here is a
 * count or a duration; nothing is a trend, because a trend is a report and
 * this is a glance.
 *
 * Every figure is scoped to a branch when one is given. A restaurant-wide
 * kitchen queue is not actionable — nobody cooks across three branches.
 */

export interface LiveOperations {
  /** The trading day these figures belong to, in the restaurant's zone. */
  businessDay: { from: Date; to: Date }

  openBills: number
  seatedCovers: number
  /** Value of everything currently on tables, still unpaid. */
  openValueMinor: number

  settledBills: number
  netSalesTodayMinor: number
  averageBillTodayMinor: number

  kitchenQueue: number
  /** Minutes since the oldest unstarted or unfinished item was ordered. */
  oldestTicketMinutes: number | null

  openServiceRequests: number
  waitingParties: number
  upcomingBookings: number
  staffOnShift: number
  lowStockCount: number
}

/** Narrows to one branch when asked, and to none when not. */
function atBranch(column: PgColumn, branchId: string | null | undefined) {
  return branchId ? eq(column, branchId) : undefined
}

/**
 * The kitchen's live queue.
 *
 * `pending` and `preparing` only. A `ready` item is the floor's problem and a
 * `served` one is nobody's — counting them would make the queue look
 * permanently deep and the number would stop meaning anything.
 */
async function readKitchenQueueIn(
  tx: Transaction,
  restaurantId: string,
  branchId: string | null | undefined,
): Promise<{ queue: number; oldest: Date | null }> {
  const [row] = await tx
    .select({
      queue: sql<number>`count(*)::int`,
      /**
       * `.mapWith` is required, not decoration. `sql<Date | null>` asserts a
       * type to TypeScript and converts nothing: Drizzle parses timestamps in
       * its column mapper, which a raw fragment bypasses, so without this the
       * value arrives as a string and `.getTime()` throws at runtime on a
       * value the compiler swore was a Date.
       */
      oldest: sql<Date | null>`min(${orderLines.placedAt})`.mapWith(
        orderLines.placedAt,
      ),
    })
    .from(orderLines)
    .innerJoin(
      diningSessions,
      eq(diningSessions.id, orderLines.sessionId),
    )
    .where(
      and(
        eq(orderLines.restaurantId, restaurantId),
        inArray(orderLines.status, ['pending', 'preparing']),
        /**
         * Only on bills that are still live.
         *
         * A closed bill can carry a line that was never advanced past
         * `pending` — nobody tapped "served" before the customer paid and
         * left. Counting those makes the queue climb all week and never fall,
         * at which point the number stops being read.
         */
        inArray(diningSessions.status, ['open', 'bill_requested']),
        atBranch(diningSessions.branchId, branchId),
      ),
    )

  return { queue: row?.queue ?? 0, oldest: row?.oldest ?? null }
}

export async function readLiveOperations(
  ctx: ReportContext,
  now: Date,
  branchId?: string | null,
): Promise<LiveOperations> {
  const day = todayRange(now, ctx.timeZone, ctx.businessDayStartMinutes)

  return withTenant(ctx, async (tx) => {
    /**
     * Open bills and what is sitting on them.
     *
     * The value comes from the order lines rather than from `calculateBill`,
     * so it is a subtotal before tax and service — deliberately, because this
     * is an at-a-glance figure and running the full bill engine for every open
     * table on every dashboard refresh is not what that engine is for. The UI
     * labels it as such rather than calling it a total.
     */
    const [open] = await tx
      .select({
        bills: sql<number>`count(*)::int`,
        /**
         * No `distinct`. Summing distinct values would count two tables of
         * four as four covers — a plausible-looking number that is wrong every
         * time two parties happen to be the same size, which on a Friday is
         * most of them.
         */
        covers: sql<number>`coalesce(sum(${diningSessions.guestCount}), 0)::int`,
      })
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.restaurantId, ctx.restaurantId),
          inArray(diningSessions.status, ['open', 'bill_requested']),
          atBranch(diningSessions.branchId, branchId),
        ),
      )

    const [openValue] = await tx
      .select({
        valueMinor: sql<number>`coalesce(sum(${orderLines.lineTotalMinor}), 0)::int`,
      })
      .from(orderLines)
      .innerJoin(diningSessions, eq(diningSessions.id, orderLines.sessionId))
      .where(
        and(
          eq(orderLines.restaurantId, ctx.restaurantId),
          inArray(diningSessions.status, ['open', 'bill_requested']),
          sql`${orderLines.status} <> 'voided'`,
          atBranch(diningSessions.branchId, branchId),
        ),
      )

    const settled = await tx
      .select({
        settledAt: salesRecords.settledAt,
        subtotalMinor: salesRecords.subtotalMinor,
        discountMinor: salesRecords.discountMinor,
        serviceChargeMinor: salesRecords.serviceChargeMinor,
        taxMinor: salesRecords.taxMinor,
        totalMinor: salesRecords.totalMinor,
        costMinor: salesRecords.costMinor,
        costedSubtotalMinor: salesRecords.costedSubtotalMinor,
        covers: salesRecords.covers,
      })
      .from(salesRecords)
      .where(
        and(
          eq(salesRecords.restaurantId, ctx.restaurantId),
          gte(salesRecords.settledAt, day.from),
          lt(salesRecords.settledAt, day.to),
          atBranch(salesRecords.branchId, branchId),
        ),
      )

    /**
     * Refunds are not deducted here.
     *
     * The dashboard is a live glance, and a mid-service query joining refunds
     * onto every bill of the day earns nothing a manager can act on before the
     * end of service. The reports page, which is where somebody goes to decide
     * something, does deduct them.
     */
    const today = summariseSales(
      settled.map((row) => ({
        ...row,
        covers: row.covers ?? 0,
        refundedMinor: 0,
      })),
    )

    const kitchen = await readKitchenQueueIn(tx, ctx.restaurantId, branchId)

    const [calls] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.restaurantId, ctx.restaurantId),
          eq(serviceRequests.status, 'open'),
        ),
      )

    const [waiting] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.restaurantId, ctx.restaurantId),
          inArray(waitlistEntries.status, ['waiting', 'notified']),
          atBranch(waitlistEntries.branchId, branchId),
        ),
      )

    /** The next four hours: long enough to prepare for, short enough to care. */
    const bookingHorizon = new Date(now.getTime() + 4 * 60 * 60_000)
    const [upcoming] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(reservations)
      .where(
        and(
          eq(reservations.restaurantId, ctx.restaurantId),
          inArray(reservations.status, ['pending', 'confirmed']),
          gte(reservations.startsAt, now),
          lte(reservations.startsAt, bookingHorizon),
          atBranch(reservations.branchId, branchId),
        ),
      )

    const [onShift] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.restaurantId, ctx.restaurantId),
          isNull(attendanceRecords.clockOutAt),
          atBranch(attendanceRecords.branchId, branchId),
        ),
      )

    /**
     * At or below the reorder point, excluding ingredients with no reorder
     * point set. A zero there means "not tracked", not "order immediately" —
     * treating it as a threshold would put every untracked ingredient on the
     * alert list and make the whole count worthless.
     */
    const [lowStock] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(stockLevels)
      .innerJoin(ingredients, eq(ingredients.id, stockLevels.ingredientId))
      .where(
        and(
          eq(stockLevels.restaurantId, ctx.restaurantId),
          eq(ingredients.isActive, true),
          sql`${ingredients.reorderPointMilli} > 0`,
          sql`${stockLevels.quantityMilli} <= ${ingredients.reorderPointMilli}`,
          atBranch(stockLevels.branchId, branchId),
        ),
      )

    return {
      businessDay: day,
      openBills: open?.bills ?? 0,
      seatedCovers: open?.covers ?? 0,
      openValueMinor: openValue?.valueMinor ?? 0,
      settledBills: today.bills,
      netSalesTodayMinor: today.netSalesMinor,
      averageBillTodayMinor: today.averageBillMinor,
      kitchenQueue: kitchen.queue,
      oldestTicketMinutes: kitchen.oldest
        ? Math.max(
            0,
            Math.floor((now.getTime() - kitchen.oldest.getTime()) / 60_000),
          )
        : null,
      openServiceRequests: calls?.count ?? 0,
      waitingParties: waiting?.count ?? 0,
      upcomingBookings: upcoming?.count ?? 0,
      staffOnShift: onShift?.count ?? 0,
      lowStockCount: lowStock?.count ?? 0,
    }
  })
}
