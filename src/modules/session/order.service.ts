import { and, asc, eq, inArray, ne } from 'drizzle-orm'

import { withTenant, type DinerContext, type Transaction } from '@/lib/db'
import {
  diningSessionMembers,
  diningSessions,
  menuItems,
  orderLineModifiers,
  orderLines,
  serviceRequests,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import {
  branchForSessionIn,
  deductForOrderLines,
  returnForVoidedLine,
} from '@/modules/inventory/inventory.service'
import { resolveStationForItem } from '@/modules/kitchen/kitchen.service'
import { loadItemModifierRulesIn } from '@/modules/modifier/modifier.service'
import {
  calculateLineTotal,
  validateModifierSelections,
} from '@/modules/modifier/pricing'
import type {
  PlaceOrderInput,
  ServiceRequestInput,
} from './session.validation'

/**
 * Order lines on a dining session.
 *
 * The single most important property of this module: **every price is
 * recomputed server-side and then frozen onto the line.** The client sends
 * what was chosen, never what it costs. A price arriving from a phone is a
 * request, not a fact.
 */

export interface PlacedLine {
  id: string
  nameSnapshot: string
  quantity: number
  lineTotalMinor: number
}

/**
 * Places a diner's order.
 *
 * Runs inside the diner's own database context: they may SELECT the menu of
 * their restaurant and INSERT into their own session, and the policies allow
 * nothing else. Even a compromised handler cannot write to another table's
 * bill from here.
 */
export async function placeDinerOrder(
  tx: Transaction,
  diner: DinerContext,
  input: PlaceOrderInput,
): Promise<PlacedLine[]> {
  const [session] = await tx
    .select({
      status: diningSessions.status,
      branchId: diningSessions.branchId,
    })
    .from(diningSessions)
    .where(eq(diningSessions.id, diner.sessionId))
    .limit(1)

  if (!session) throw new NotFoundError('Your table session has ended.')

  /**
   * Once the bill is requested the total is being settled; letting an order
   * land after that silently changes what someone is in the middle of paying.
   */
  if (session.status !== 'open') {
    throw new ConflictError(
      'The bill has been requested for this table, so no more items can be added. Please ask a member of staff.',
    )
  }

  const itemIds = [...new Set(input.lines.map((l) => l.menuItemId))]

  const items = await tx
    .select({
      id: menuItems.id,
      name: menuItems.name,
      priceMinor: menuItems.priceMinor,
      status: menuItems.status,
    })
    .from(menuItems)
    .where(inArray(menuItems.id, itemIds))

  const itemById = new Map(items.map((i) => [i.id, i]))
  const placed: PlacedLine[] = []

  for (const [index, line] of input.lines.entries()) {
    const item = itemById.get(line.menuItemId)

    // Unknown or another restaurant's item: the diner-read policy simply did
    // not return it, so both cases look identical here, as they should.
    if (!item) {
      throw new NotFoundError('One of those items is no longer on the menu.')
    }

    if (item.status !== 'active') {
      throw new ConflictError(`"${item.name}" is not available right now.`)
    }

    const groups = await loadItemModifierRulesIn(
      tx,
      diner.restaurantId,
      line.menuItemId,
    )

    const selections = line.modifierSelections.map((s) => ({
      groupId: s.groupId,
      optionId: s.optionId,
      quantity: s.quantity,
    }))

    try {
      validateModifierSelections(groups, selections)
    } catch (error) {
      // Re-thrown with the line index so the UI can point at the right card.
      if (error instanceof ValidationError) {
        throw new ValidationError(
          `"${item.name}": ${error.message}`,
          Object.fromEntries(
            Object.entries(error.details ?? {}).map(([k, v]) => [
              `lines.${index}.${k}`,
              v,
            ]),
          ),
        )
      }
      throw error
    }

    const total = calculateLineTotal({
      basePriceMinor: item.priceMinor,
      quantity: line.quantity,
      modifierGroups: groups,
      modifierSelections: selections,
    })

    /**
     * Resolved once, here, and frozen onto the line. Re-routing the menu
     * later must not move a ticket that is already being cooked.
     */
    const kitchenStationId = await resolveStationForItem(
      tx,
      diner.restaurantId,
      session.branchId,
      item.id,
    )

    const [created] = await tx
      .insert(orderLines)
      .values({
        restaurantId: diner.restaurantId,
        sessionId: diner.sessionId,
        // Null attributes the dish to the whole table — what Phase 6 splits.
        memberId: line.isShared ? null : diner.memberId,
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
      const optionLookup = new Map(
        groups.flatMap((g) =>
          g.options.map(
            (o) => [o.optionId, { group: g.name, option: o }] as const,
          ),
        ),
      )

      await tx.insert(orderLineModifiers).values(
        selections.map((selection) => {
          const found = optionLookup.get(selection.optionId)!
          return {
            restaurantId: diner.restaurantId,
            sessionId: diner.sessionId,
            orderLineId: created.id,
            modifierOptionId: selection.optionId,
            // Snapshots, so a receipt reprinted next month still reads
            // "Size / Large +1.50" even if that option was renamed since.
            groupNameSnapshot: found.group,
            optionNameSnapshot: found.option.name,
            priceDeltaMinor: found.option.priceDeltaMinor,
            quantity: selection.quantity,
          }
        }),
      )
    }

    placed.push({
      id: created.id,
      nameSnapshot: item.name,
      quantity: line.quantity,
      lineTotalMinor: total.lineTotalMinor,
    })
  }

  /**
   * A QR order consumes ingredients exactly as a staff order does. Deducting
   * on only one of the two paths is how an inventory system ends up wrong by
   * precisely the proportion of self-ordering customers.
   *
   * No `userId`: nobody on staff placed this, and attributing it to whoever
   * happened to be logged in elsewhere would put a name against an action
   * they did not take.
   */
  await deductForOrderLines(
    tx,
    diner.restaurantId,
    session.branchId,
    diner.sessionId,
    placed.map((line) => line.id),
    null,
  )

  return placed
}

export interface SessionLine {
  id: string
  memberId: string | null
  memberName: string | null
  nameSnapshot: string
  quantity: number
  unitPriceMinor: number
  lineTotalMinor: number
  status: 'pending' | 'preparing' | 'ready' | 'served' | 'voided'
  notes: string | null
  placedAt: Date
  modifiers: { group: string; option: string; priceDeltaMinor: number }[]
}

export interface SessionBill {
  lines: SessionLine[]
  /** Lines belonging to this member. */
  personalTotalMinor: number
  /** Lines with no owner — shared by the table. */
  sharedTotalMinor: number
  /** Everything on the table, voided lines excluded. */
  sessionTotalMinor: number
}

/**
 * Reads the session's lines and totals.
 *
 * Note what `personalTotalMinor` deliberately is NOT: it does not include a
 * share of the shared items. Deciding how a shared dish is divided — evenly,
 * by who ate it, by percentage — is the whole substance of Smart Bill in
 * Phase 6, and inventing an answer here would bake one policy in before that
 * design exists. Shared items are reported separately and honestly.
 */
export async function readSessionBill(
  tx: Transaction,
  sessionId: string,
  memberId: string | null,
): Promise<SessionBill> {
  const lines = await tx
    .select({
      id: orderLines.id,
      memberId: orderLines.memberId,
      memberName: diningSessionMembers.displayName,
      nameSnapshot: orderLines.nameSnapshot,
      quantity: orderLines.quantity,
      unitPriceMinor: orderLines.unitPriceMinor,
      lineTotalMinor: orderLines.lineTotalMinor,
      status: orderLines.status,
      notes: orderLines.notes,
      placedAt: orderLines.placedAt,
    })
    .from(orderLines)
    .leftJoin(
      diningSessionMembers,
      eq(diningSessionMembers.id, orderLines.memberId),
    )
    .where(
      and(eq(orderLines.sessionId, sessionId), ne(orderLines.status, 'voided')),
    )
    .orderBy(asc(orderLines.placedAt))

  const modifiers =
    lines.length === 0
      ? []
      : await tx
          .select({
            orderLineId: orderLineModifiers.orderLineId,
            group: orderLineModifiers.groupNameSnapshot,
            option: orderLineModifiers.optionNameSnapshot,
            priceDeltaMinor: orderLineModifiers.priceDeltaMinor,
          })
          .from(orderLineModifiers)
          .where(
            inArray(
              orderLineModifiers.orderLineId,
              lines.map((l) => l.id),
            ),
          )

  const byLine = new Map<string, SessionLine['modifiers']>()
  for (const modifier of modifiers) {
    const list = byLine.get(modifier.orderLineId) ?? []
    list.push(modifier)
    byLine.set(modifier.orderLineId, list)
  }

  const enriched: SessionLine[] = lines.map((line) => ({
    ...line,
    modifiers: byLine.get(line.id) ?? [],
  }))

  return {
    lines: enriched,
    personalTotalMinor: enriched
      .filter((l) => memberId !== null && l.memberId === memberId)
      .reduce((sum, l) => sum + l.lineTotalMinor, 0),
    sharedTotalMinor: enriched
      .filter((l) => l.memberId === null)
      .reduce((sum, l) => sum + l.lineTotalMinor, 0),
    sessionTotalMinor: enriched.reduce(
      (sum, l) => sum + l.lineTotalMinor,
      0,
    ),
  }
}

export async function raiseServiceRequest(
  tx: Transaction,
  diner: DinerContext,
  input: ServiceRequestInput,
): Promise<{ id: string }> {
  /**
   * Deduplicated per member per type. A diner tapping "call waiter" five
   * times while nobody comes should not produce five identical rows for the
   * floor staff to dismiss individually.
   */
  const [existing] = await tx
    .select({ id: serviceRequests.id })
    .from(serviceRequests)
    .where(
      and(
        eq(serviceRequests.sessionId, diner.sessionId),
        eq(serviceRequests.type, input.type),
        eq(serviceRequests.status, 'open'),
      ),
    )
    .limit(1)

  if (existing) return { id: existing.id }

  const [created] = await tx
    .insert(serviceRequests)
    .values({
      restaurantId: diner.restaurantId,
      sessionId: diner.sessionId,
      memberId: diner.memberId,
      type: input.type,
      note: input.note ?? null,
    })
    .returning({ id: serviceRequests.id })

  return { id: created.id }
}

/**
 * Voids a line. Staff only, and never a delete.
 *
 * The row stays with `status = 'voided'` so the fact that something was
 * ordered and then removed survives on the record — which is exactly what an
 * owner reviewing suspicious discounts needs to see.
 */
export async function voidOrderLine(
  ctx: BranchActorContext,
  orderLineId: string,
  reason?: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [line] = await tx
      .select({
        id: orderLines.id,
        sessionId: orderLines.sessionId,
        nameSnapshot: orderLines.nameSnapshot,
        lineTotalMinor: orderLines.lineTotalMinor,
        status: orderLines.status,
      })
      .from(orderLines)
      .where(
        and(
          eq(orderLines.id, orderLineId),
          eq(orderLines.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!line) throw new NotFoundError('Order line not found.')
    if (line.status === 'voided') {
      throw new ConflictError('That item has already been voided.')
    }

    await tx
      .update(orderLines)
      .set({
        status: 'voided',
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        notes: reason ?? line.nameSnapshot,
      })
      .where(eq(orderLines.id, orderLineId))

    /**
     * A voided line puts its ingredients back, as a `return` movement rather
     * than by unwinding the consumption. The ledger is append-only because
     * "why do we think we have 4 kg?" must always have an answer, and a
     * deleted row is the one answer it cannot give.
     *
     * This is honest only for a dish that was never made. A voided line that
     * the kitchen already cooked has genuinely consumed its ingredients, and
     * the correct record is wastage — which is why voiding after the ticket
     * has been started is worth revisiting once wastage-on-void is a
     * question anyone has asked.
     */
    const branchId = await branchForSessionIn(tx, line.sessionId)
    if (branchId) {
      await returnForVoidedLine(
        tx,
        ctx.restaurantId,
        branchId,
        line.sessionId,
        orderLineId,
        ctx.userId,
      )
    }

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'order.line_voided',
      entityType: 'order_line',
      entityId: orderLineId,
      before: line,
      after: { status: 'voided', reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/** Staff-side read of a session's bill. */
export async function readSessionBillForStaff(
  restaurantId: string,
  userId: string,
  sessionId: string,
): Promise<SessionBill> {
  return withTenant({ restaurantId, userId }, (tx) =>
    readSessionBill(tx, sessionId, null),
  )
}
