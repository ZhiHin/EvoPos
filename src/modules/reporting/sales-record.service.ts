import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  diningSessions,
  orderLines,
  restaurants,
  salesRecords,
  stockMovements,
} from '@/lib/db/schema'
import { NotFoundError } from '@/lib/errors'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { enqueueEventIn } from '@/modules/integration/webhook.service'
import { computeSessionTotals } from '@/modules/pos/pos.service'

/**
 * Writing the financial record of a settled bill.
 *
 * See `src/lib/db/schema/reporting.ts` for why this exists at all. In short: a
 * report recomputed from live settings changes when the settings change, and a
 * tax return that quietly restates itself after filing is not a report.
 */

interface Consumption {
  costMinor: number
  costedSubtotalMinor: number
}

/**
 * What this bill cost to make, from the stock ledger.
 *
 * Read from the movements the order actually generated rather than from
 * today's ingredient costs, which move with every delivery. The ledger
 * snapshotted the cost per unit at the moment of consumption precisely so
 * this number can be asked for again next year and give the same answer.
 *
 * Returns are included: voiding a line puts the stock back, and a bill should
 * not carry the cost of a dish that was never made.
 */
async function readConsumptionIn(
  tx: Transaction,
  sessionId: string,
): Promise<Consumption> {
  const [valued] = await tx
    .select({
      // Consumption is signed negative, returns positive, so the negated sum
      // is the net cost.
      valueMinor: sql<number>`coalesce(sum(${stockMovements.valueMinor}), 0)::int`,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.sessionId, sessionId),
        inArray(stockMovements.kind, ['consumption', 'return']),
      ),
    )

  /**
   * How much of this bill has a recipe behind it, read from the lines rather
   * than from the ledger.
   *
   * A consumption movement covers a whole order — one row per ingredient, not
   * per line — so it cannot say which dish consumed what. The line carries its
   * own cost snapshot for exactly this reason, and a NULL there means the item
   * has no recipe.
   */
  const [costed] = await tx
    .select({
      subtotalMinor: sql<number>`coalesce(sum(${orderLines.lineTotalMinor}), 0)::int`,
    })
    .from(orderLines)
    .where(
      and(
        eq(orderLines.sessionId, sessionId),
        ne(orderLines.status, 'voided'),
        isNotNull(orderLines.costMinor),
      ),
    )

  return {
    costMinor: -(valued?.valueMinor ?? 0),
    costedSubtotalMinor: costed?.subtotalMinor ?? 0,
  }
}

/**
 * Snapshots a settled bill.
 *
 * Idempotent on the session, backed by a unique index. A retried close must
 * not write a second row: every underlying payment would still be correct
 * while the day's reported revenue silently doubled, and a discrepancy that
 * only shows in the total is extremely hard to trace back to its cause.
 */
export async function recordSale(
  ctx: BranchActorContext,
  sessionId: string,
  paidMinor: number,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [session] = await tx
      .select({
        branchId: diningSessions.branchId,
        type: diningSessions.type,
        guestCount: diningSessions.guestCount,
        customerId: diningSessions.customerId,
      })
      .from(diningSessions)
      .where(eq(diningSessions.id, sessionId))
      .limit(1)

    if (!session) throw new NotFoundError('That bill was not found.')

    const [rates] = await tx
      .select({
        taxRateBasisPoints: restaurants.taxRateBasisPoints,
        serviceChargeBasisPoints: restaurants.serviceChargeBasisPoints,
      })
      .from(restaurants)
      .where(eq(restaurants.id, ctx.restaurantId))
      .limit(1)

    if (!rates) throw new NotFoundError('Restaurant not found.')

    const totals = await computeSessionTotals(tx, ctx.restaurantId, sessionId)
    const consumption = await readConsumptionIn(tx, sessionId)

    await tx
      .insert(salesRecords)
      .values({
        restaurantId: ctx.restaurantId,
        branchId: session.branchId,
        sessionId,
        type: session.type,
        covers: session.guestCount,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        serviceChargeMinor: totals.serviceChargeMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        paidMinor,
        taxRateBasisPoints: rates.taxRateBasisPoints,
        serviceChargeBasisPoints: rates.serviceChargeBasisPoints,
        taxIsIncluded: totals.taxIsIncluded,
        costMinor: consumption.costMinor,
        costedSubtotalMinor: consumption.costedSubtotalMinor,
        customerId: session.customerId,
        settledByUserId: ctx.userId,
      })
      /**
       * Do nothing rather than update. The first record is the true one: it
       * was written with the rates and the totals in force when the customer
       * actually paid, and a later pass would overwrite them with whatever is
       * current — reintroducing exactly the drift this table exists to stop.
       */
      .onConflictDoNothing({ target: salesRecords.sessionId })

    /**
     * Told to anyone subscribed, in the same transaction as the record itself
     * — so there is no window in which a webhook describes a bill that was
     * never written, or a bill exists that nobody was told about.
     *
     * Queued, not sent. A customer's slow endpoint must not be able to make
     * settling a bill slow, and must certainly not be able to make it fail.
     */
    await enqueueEventIn(tx, ctx.restaurantId, 'bill.settled', {
      sessionId,
      branchId: session.branchId,
      type: session.type,
      covers: session.guestCount,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      serviceChargeMinor: totals.serviceChargeMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      paidMinor,
      settledAt: new Date().toISOString(),
    })
  })
}
