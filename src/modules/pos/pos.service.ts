import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  diningSessionMembers,
  diningSessions,
  diningTables,
  menuItems,
  orderLineModifiers,
  orderLines,
  restaurants,
  serviceRequests,
  sessionDiscounts,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import {
  deductForOrderLines,
  type StockShortfall,
} from '@/modules/inventory/inventory.service'
import { resolveStationForItem } from '@/modules/kitchen/kitchen.service'
import { loadItemModifierRulesIn } from '@/modules/modifier/modifier.service'
import {
  calculateLineTotal,
  validateModifierSelections,
} from '@/modules/modifier/pricing'
import { readSessionPromotionDiscount } from '@/modules/promotion/promotion.service'
import { calculateBill, type BillTotals } from './bill'
import type {
  ApplyDiscountInput,
  MergeSessionsInput,
  OpenTakeawayInput,
  StaffOrderInput,
  TransferSessionInput,
} from './pos.validation'

const LIVE_STATUSES = ['open', 'bill_requested'] as const

/**
 * Opens a takeaway or delivery session.
 *
 * No table, so no partial-unique-index contention — unlimited takeaway
 * sessions coexist, which is also what makes "hold order" free: an open
 * table-less session is already a parked transaction.
 */
export async function openTakeawaySession(
  ctx: BranchActorContext,
  input: OpenTakeawayInput,
): Promise<{ sessionId: string }> {
  return withTenant(ctx, async (tx) => {
    const [created] = await tx
      .insert(diningSessions)
      .values({
        restaurantId: ctx.restaurantId,
        branchId: input.branchId,
        tableId: null,
        type: input.type,
        openedByUserId: ctx.userId,
        customerName: input.customerName ?? null,
        customerPhone: input.customerPhone ?? null,
        deliveryAddress: input.deliveryAddress ?? null,
      })
      .returning({ id: diningSessions.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: `session.opened_${input.type}`,
      entityType: 'dining_session',
      entityId: created.id,
      after: { type: input.type, customerName: input.customerName },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { sessionId: created.id }
  })
}

/**
 * Places an order on behalf of a diner, from the POS.
 *
 * Shares the pricing path with `placeDinerOrder` rather than duplicating it:
 * prices are recomputed from stored rules and frozen onto the line, and a
 * waiter keying an order gets exactly the same arithmetic a customer's phone
 * would. The differences are that staff may attribute a line to a specific
 * member, and may add to a session whose bill has been requested — because a
 * customer asking for "one more coffee" after requesting the bill is normal,
 * and a waiter is standing there to judge it.
 */
export async function placeStaffOrder(
  ctx: BranchActorContext,
  sessionId: string,
  input: StaffOrderInput,
): Promise<{ lineIds: string[]; shortfalls: StockShortfall[] }> {
  return withTenant(ctx, async (tx) => {
    const [session] = await tx
      .select({
        id: diningSessions.id,
        status: diningSessions.status,
        branchId: diningSessions.branchId,
      })
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.id, sessionId),
          eq(diningSessions.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!session) throw new NotFoundError('Session not found.')
    if (session.status === 'closed' || session.status === 'abandoned') {
      throw new ConflictError('That bill has already been settled.')
    }

    const lineIds: string[] = []

    for (const line of input.lines) {
      const [item] = await tx
        .select({
          id: menuItems.id,
          name: menuItems.name,
          priceMinor: menuItems.priceMinor,
          status: menuItems.status,
        })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.id, line.menuItemId),
            eq(menuItems.restaurantId, ctx.restaurantId),
          ),
        )
        .limit(1)

      if (!item) throw new NotFoundError('Menu item not found.')

      if (line.memberId) {
        const [member] = await tx
          .select({ id: diningSessionMembers.id })
          .from(diningSessionMembers)
          .where(
            and(
              eq(diningSessionMembers.id, line.memberId),
              eq(diningSessionMembers.sessionId, sessionId),
            ),
          )
          .limit(1)

        // Attributing a dish to someone at a different table would corrupt
        // both bills, so the member must belong to this session.
        if (!member) {
          throw new NotFoundError('That diner is not at this table.')
        }
      }

      const groups = await loadItemModifierRulesIn(
        tx,
        ctx.restaurantId,
        line.menuItemId,
      )

      const selections = line.modifierSelections.map((s) => ({
        groupId: s.groupId,
        optionId: s.optionId,
        quantity: s.quantity,
      }))

      validateModifierSelections(groups, selections)

      const total = calculateLineTotal({
        basePriceMinor: item.priceMinor,
        quantity: line.quantity,
        modifierGroups: groups,
        modifierSelections: selections,
      })

      // Frozen at order time, exactly as on the diner path.
      const kitchenStationId = await resolveStationForItem(
        tx,
        ctx.restaurantId,
        session.branchId,
        item.id,
      )

      const [created] = await tx
        .insert(orderLines)
        .values({
          restaurantId: ctx.restaurantId,
          sessionId,
          memberId: line.memberId ?? null,
          menuItemId: item.id,
          kitchenStationId,
          nameSnapshot: item.name,
          unitPriceMinor: total.unitPriceMinor,
          quantity: line.quantity,
          lineTotalMinor: total.lineTotalMinor,
          notes: line.notes ?? null,
        })
        .returning({ id: orderLines.id })

      if (selections.length > 0) {
        const lookup = new Map(
          groups.flatMap((g) =>
            g.options.map(
              (o) => [o.optionId, { group: g.name, option: o }] as const,
            ),
          ),
        )

        await tx.insert(orderLineModifiers).values(
          selections.map((selection) => {
            const found = lookup.get(selection.optionId)!
            return {
              restaurantId: ctx.restaurantId,
              sessionId,
              orderLineId: created.id,
              modifierOptionId: selection.optionId,
              groupNameSnapshot: found.group,
              optionNameSnapshot: found.option.name,
              priceDeltaMinor: found.option.priceDeltaMinor,
              quantity: selection.quantity,
            }
          }),
        )
      }

      lineIds.push(created.id)
    }

    /**
     * Stock moves in the same transaction as the order. If the deduction were
     * a separate call, an order could be recorded and its ingredients not,
     * and the drift would be silent until someone counted the shelf.
     *
     * Shortfalls are returned, never enforced — see `deductForOrderLines`.
     */
    const { shortfalls } = await deductForOrderLines(
      tx,
      ctx.restaurantId,
      session.branchId,
      sessionId,
      lineIds,
      ctx.userId,
    )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'order.placed_by_staff',
      entityType: 'dining_session',
      entityId: sessionId,
      after: { lineCount: lineIds.length },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { lineIds, shortfalls }
  })
}

/**
 * Moves a session to a different table.
 *
 * The target must have no live session of its own, which the partial unique
 * index would reject anyway — checked first so the failure is a readable
 * message rather than a constraint violation.
 */
export async function transferSession(
  ctx: BranchActorContext,
  sessionId: string,
  input: TransferSessionInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [session] = await tx
      .select({
        id: diningSessions.id,
        tableId: diningSessions.tableId,
        status: diningSessions.status,
        branchId: diningSessions.branchId,
      })
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.id, sessionId),
          eq(diningSessions.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!session) throw new NotFoundError('Session not found.')
    if (!LIVE_STATUSES.includes(session.status as 'open')) {
      throw new ConflictError('That bill has already been settled.')
    }

    const [target] = await tx
      .select({
        id: diningTables.id,
        code: diningTables.code,
        branchId: diningTables.branchId,
      })
      .from(diningTables)
      .where(
        and(
          eq(diningTables.id, input.tableId),
          eq(diningTables.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!target) throw new NotFoundError('Table not found.')

    /**
     * Moving a bill between branches would put a table's takings in the wrong
     * branch's reports, which is the kind of error nobody notices until a
     * month-end reconciliation fails.
     */
    if (target.branchId !== session.branchId) {
      throw new ConflictError('A session cannot move to a different branch.')
    }

    const [occupied] = await tx
      .select({ id: diningSessions.id })
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.tableId, input.tableId),
          inArray(diningSessions.status, LIVE_STATUSES),
        ),
      )
      .limit(1)

    if (occupied) {
      throw new ConflictError(
        `Table ${target.code} already has an open bill. Merge them instead.`,
      )
    }

    await tx
      .update(diningSessions)
      .set({ tableId: input.tableId })
      .where(eq(diningSessions.id, sessionId))

    if (session.tableId) {
      await tx
        .update(diningTables)
        .set({ status: 'available' })
        .where(eq(diningTables.id, session.tableId))
    }

    await tx
      .update(diningTables)
      .set({ status: 'occupied' })
      .where(eq(diningTables.id, input.tableId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'session.transferred',
      entityType: 'dining_session',
      entityId: sessionId,
      before: { tableId: session.tableId },
      after: { tableId: input.tableId, tableCode: target.code },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Merges one session into another.
 *
 * Everything that references the source moves: order lines, their frozen
 * modifiers, members, discounts and open service requests. The source is then
 * closed and its table freed.
 *
 * Note the members move rather than being dropped. An order line points at
 * the member who ordered it, and losing that would turn every attributed dish
 * on the absorbed bill into a shared one — silently changing who owes what,
 * which is precisely what Phase 6 must be able to rely on.
 */
export async function mergeSessions(
  ctx: BranchActorContext,
  targetSessionId: string,
  input: MergeSessionsInput,
): Promise<{ movedLines: number }> {
  return withTenant(ctx, async (tx) => {
    if (targetSessionId === input.sourceSessionId) {
      throw new ConflictError('A bill cannot be merged into itself.')
    }

    const sessions = await tx
      .select({
        id: diningSessions.id,
        tableId: diningSessions.tableId,
        status: diningSessions.status,
        branchId: diningSessions.branchId,
      })
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.restaurantId, ctx.restaurantId),
          inArray(diningSessions.id, [targetSessionId, input.sourceSessionId]),
        ),
      )

    const target = sessions.find((s) => s.id === targetSessionId)
    const source = sessions.find((s) => s.id === input.sourceSessionId)

    if (!target || !source) throw new NotFoundError('Session not found.')

    for (const session of [target, source]) {
      if (!LIVE_STATUSES.includes(session.status as 'open')) {
        throw new ConflictError(
          'One of those bills has already been settled.',
        )
      }
    }

    if (target.branchId !== source.branchId) {
      throw new ConflictError('Bills from different branches cannot be merged.')
    }

    const moved = await tx
      .update(orderLines)
      .set({ sessionId: targetSessionId })
      .where(eq(orderLines.sessionId, input.sourceSessionId))
      .returning({ id: orderLines.id })

    await tx
      .update(orderLineModifiers)
      .set({ sessionId: targetSessionId })
      .where(eq(orderLineModifiers.sessionId, input.sourceSessionId))

    await tx
      .update(diningSessionMembers)
      .set({ sessionId: targetSessionId })
      .where(eq(diningSessionMembers.sessionId, input.sourceSessionId))

    await tx
      .update(sessionDiscounts)
      .set({ sessionId: targetSessionId })
      .where(eq(sessionDiscounts.sessionId, input.sourceSessionId))

    await tx
      .update(serviceRequests)
      .set({ sessionId: targetSessionId })
      .where(eq(serviceRequests.sessionId, input.sourceSessionId))

    const now = new Date()

    await tx
      .update(diningSessions)
      .set({
        status: 'closed',
        closedAt: now,
        notes: `Merged into ${targetSessionId}`,
      })
      .where(eq(diningSessions.id, input.sourceSessionId))

    if (source.tableId) {
      await tx
        .update(diningTables)
        .set({ status: 'available' })
        .where(eq(diningTables.id, source.tableId))
    }

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'session.merged',
      entityType: 'dining_session',
      entityId: targetSessionId,
      after: {
        sourceSessionId: input.sourceSessionId,
        movedLines: moved.length,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { movedLines: moved.length }
  })
}

export async function applyDiscount(
  ctx: BranchActorContext,
  sessionId: string,
  input: ApplyDiscountInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [session] = await tx
      .select({ id: diningSessions.id, status: diningSessions.status })
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.id, sessionId),
          eq(diningSessions.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!session) throw new NotFoundError('Session not found.')
    if (session.status === 'closed') {
      throw new ConflictError('That bill has already been settled.')
    }

    const [created] = await tx
      .insert(sessionDiscounts)
      .values({
        restaurantId: ctx.restaurantId,
        sessionId,
        type: input.type,
        value: input.value,
        reason: input.reason,
        appliedByUserId: ctx.userId,
      })
      .returning({ id: sessionDiscounts.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'discount.applied',
      entityType: 'dining_session',
      entityId: sessionId,
      after: { type: input.type, value: input.value, reason: input.reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

/** Soft-removes a discount. The row survives so the trail survives. */
export async function removeDiscount(
  ctx: BranchActorContext,
  discountId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        id: sessionDiscounts.id,
        sessionId: sessionDiscounts.sessionId,
        reason: sessionDiscounts.reason,
        removedAt: sessionDiscounts.removedAt,
      })
      .from(sessionDiscounts)
      .where(
        and(
          eq(sessionDiscounts.id, discountId),
          eq(sessionDiscounts.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Discount not found.')
    if (existing.removedAt) {
      throw new ConflictError('That discount has already been removed.')
    }

    await tx
      .update(sessionDiscounts)
      .set({ removedAt: new Date(), removedByUserId: ctx.userId })
      .where(eq(sessionDiscounts.id, discountId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'discount.removed',
      entityType: 'dining_session',
      entityId: existing.sessionId,
      before: { discountId, reason: existing.reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/** Marks a waiter call or bill request as handled. */
export async function resolveServiceRequest(
  ctx: BranchActorContext,
  requestId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        id: serviceRequests.id,
        sessionId: serviceRequests.sessionId,
        type: serviceRequests.type,
        status: serviceRequests.status,
      })
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.id, requestId),
          eq(serviceRequests.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Request not found.')
    if (existing.status === 'resolved') return

    await tx
      .update(serviceRequests)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedByUserId: ctx.userId,
      })
      .where(eq(serviceRequests.id, requestId))

    /**
     * Acknowledging a bill request moves the session into `bill_requested`,
     * which is what stops diners adding to a total someone is settling.
     */
    if (existing.type === 'request_bill') {
      await tx
        .update(diningSessions)
        .set({ status: 'bill_requested' })
        .where(
          and(
            eq(diningSessions.id, existing.sessionId),
            eq(diningSessions.status, 'open'),
          ),
        )
    }
  })
}

export interface SessionTotals extends BillTotals {
  discounts: {
    id: string
    type: 'percentage' | 'fixed'
    value: number
    reason: string
    /**
     * A promotion is removed by re-evaluating or by voiding its voucher, not
     * by deleting a discount row that does not exist. The till needs to know
     * which kind it is looking at before offering a remove button.
     */
    source: 'manual' | 'promotion'
  }[]
}

/**
 * Computes a session's bill from its stored lines, discounts and the
 * restaurant's tax settings.
 *
 * Voided lines are excluded here rather than filtered by the caller, so no
 * caller can forget and charge for something a manager removed.
 */
export async function computeSessionTotals(
  tx: Transaction,
  restaurantId: string,
  sessionId: string,
): Promise<SessionTotals> {
  const [settings] = await tx
    .select({
      taxRateBasisPoints: restaurants.taxRateBasisPoints,
      serviceChargeBasisPoints: restaurants.serviceChargeBasisPoints,
      taxInclusive: restaurants.taxInclusive,
    })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)

  if (!settings) throw new NotFoundError('Restaurant not found.')

  const lines = await tx
    .select({ lineTotalMinor: orderLines.lineTotalMinor })
    .from(orderLines)
    .where(
      and(
        eq(orderLines.sessionId, sessionId),
        sql`${orderLines.status} <> 'voided'`,
      ),
    )

  const manual = await tx
    .select({
      id: sessionDiscounts.id,
      type: sessionDiscounts.type,
      value: sessionDiscounts.value,
      reason: sessionDiscounts.reason,
    })
    .from(sessionDiscounts)
    .where(
      and(
        eq(sessionDiscounts.sessionId, sessionId),
        isNull(sessionDiscounts.removedAt),
      ),
    )

  /**
   * Promotions reduce the bill through the same pipeline as a manual
   * discount, so they land before service charge and tax like every other
   * reduction. A separate path would be a second order of operations, and the
   * two would disagree the first time either changed.
   *
   * The engine has already resolved each promotion to an exact amount, so it
   * enters as a fixed discount — re-deriving a percentage here would round a
   * second time against a subtotal the engine never saw.
   */
  const promotional = await readSessionPromotionDiscount(tx, sessionId)

  const discounts: SessionTotals['discounts'] = [
    ...manual.map((d) => ({ ...d, source: 'manual' as const })),
    ...promotional.entries.map((entry, index) => ({
      id: `promotion:${entry.promotionId || index}`,
      type: 'fixed' as const,
      value: entry.discountMinor,
      reason: entry.name,
      source: 'promotion' as const,
    })),
  ]

  const totals = calculateBill(
    lines.map((l) => l.lineTotalMinor),
    settings,
    discounts,
  )

  return { ...totals, discounts }
}

export async function readSessionTotals(
  restaurantId: string,
  userId: string,
  sessionId: string,
): Promise<SessionTotals> {
  return withTenant({ restaurantId, userId }, (tx) =>
    computeSessionTotals(tx, restaurantId, sessionId),
  )
}
