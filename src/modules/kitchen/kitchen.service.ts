import { and, asc, eq, inArray } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  diningSessions,
  diningTables,
  kitchenStations,
  menuCategories,
  menuItems,
  orderLineModifiers,
  orderLines,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'

/**
 * Kitchen display and routing.
 *
 * A ticket is not a stored entity — it is a view over `order_lines` filtered
 * by station and status. Duplicating lines into a tickets table would create
 * two answers to "is this cooked yet", and they would eventually disagree.
 */

export type OrderLineStatus =
  | 'pending'
  | 'preparing'
  | 'ready'
  | 'served'
  | 'voided'

/**
 * Where a dish is made: the item's own station, else its category's, else the
 * branch default.
 *
 * Returns null when a branch has no stations at all, which is the ordinary
 * state for a restaurant that has not set any up. An unrouted line simply
 * appears on no screen rather than blocking the order — a kitchen that has
 * not adopted the KDS must still be able to take orders.
 */
export async function resolveStationForItem(
  tx: Transaction,
  restaurantId: string,
  branchId: string,
  menuItemId: string,
): Promise<string | null> {
  const [item] = await tx
    .select({
      itemStationId: menuItems.kitchenStationId,
      categoryStationId: menuCategories.kitchenStationId,
    })
    .from(menuItems)
    .leftJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId))
    .where(
      and(
        eq(menuItems.id, menuItemId),
        eq(menuItems.restaurantId, restaurantId),
      ),
    )
    .limit(1)

  const preferred = item?.itemStationId ?? item?.categoryStationId ?? null

  if (preferred) {
    /**
     * A station configured on the menu belongs to one branch, and the menu is
     * shared across all of them. Ordering the same dish at a different branch
     * must fall through to that branch's own station rather than routing a
     * ticket to a kitchen in another building.
     */
    const [valid] = await tx
      .select({ id: kitchenStations.id })
      .from(kitchenStations)
      .where(
        and(
          eq(kitchenStations.id, preferred),
          eq(kitchenStations.branchId, branchId),
          eq(kitchenStations.isActive, true),
        ),
      )
      .limit(1)

    if (valid) return valid.id
  }

  const [fallback] = await tx
    .select({ id: kitchenStations.id })
    .from(kitchenStations)
    .where(
      and(
        eq(kitchenStations.branchId, branchId),
        eq(kitchenStations.isDefault, true),
        eq(kitchenStations.isActive, true),
      ),
    )
    // Lowest display order wins if more than one is marked default, so a
    // moment of misconfiguration still routes somewhere deterministic.
    .orderBy(asc(kitchenStations.displayOrder))
    .limit(1)

  return fallback?.id ?? null
}

export interface KitchenTicketLine {
  id: string
  quantity: number
  nameSnapshot: string
  notes: string | null
  status: OrderLineStatus
  placedAt: Date
  startedAt: Date | null
  modifiers: string[]
}

export interface KitchenTicketGroup {
  sessionId: string
  destination: string
  orderReference: string
  /** Oldest line on the ticket — what the timer counts from. */
  placedAt: Date
  lines: KitchenTicketLine[]
}

/**
 * The live queue for a station.
 *
 * Lines are grouped by session because a kitchen works a table at a time —
 * plating two dishes for one party together is the difference between food
 * arriving hot and arriving separately.
 *
 * Served and voided lines are excluded: the screen shows outstanding work,
 * not history.
 */
export async function readKitchenQueue(
  restaurantId: string,
  userId: string,
  branchId: string,
  stationId?: string,
): Promise<KitchenTicketGroup[]> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const lines = await tx
      .select({
        id: orderLines.id,
        sessionId: orderLines.sessionId,
        quantity: orderLines.quantity,
        nameSnapshot: orderLines.nameSnapshot,
        notes: orderLines.notes,
        status: orderLines.status,
        placedAt: orderLines.placedAt,
        startedAt: orderLines.startedAt,
        tableCode: diningTables.code,
        customerName: diningSessions.customerName,
        sessionType: diningSessions.type,
      })
      .from(orderLines)
      .innerJoin(diningSessions, eq(diningSessions.id, orderLines.sessionId))
      .leftJoin(diningTables, eq(diningTables.id, diningSessions.tableId))
      .where(
        and(
          eq(orderLines.restaurantId, restaurantId),
          eq(diningSessions.branchId, branchId),
          inArray(orderLines.status, ['pending', 'preparing', 'ready']),
          /**
           * With no station chosen the condition is simply absent, so the
           * screen shows every outstanding line including unrouted ones — a
           * restaurant that has not configured stations still sees its
           * orders rather than an empty board.
           */
          ...(stationId ? [eq(orderLines.kitchenStationId, stationId)] : []),
        ),
      )
      .orderBy(asc(orderLines.placedAt))

    if (lines.length === 0) return []

    const modifiers = await tx
      .select({
        orderLineId: orderLineModifiers.orderLineId,
        group: orderLineModifiers.groupNameSnapshot,
        option: orderLineModifiers.optionNameSnapshot,
      })
      .from(orderLineModifiers)
      .where(
        inArray(
          orderLineModifiers.orderLineId,
          lines.map((l) => l.id),
        ),
      )

    const modifiersByLine = new Map<string, string[]>()
    for (const modifier of modifiers) {
      const list = modifiersByLine.get(modifier.orderLineId) ?? []
      list.push(`${modifier.group}: ${modifier.option}`)
      modifiersByLine.set(modifier.orderLineId, list)
    }

    const groups = new Map<string, KitchenTicketGroup>()

    for (const line of lines) {
      const existing = groups.get(line.sessionId) ?? {
        sessionId: line.sessionId,
        destination:
          line.tableCode ??
          line.customerName ??
          (line.sessionType === 'delivery' ? 'Delivery' : 'Takeaway'),
        orderReference: `#${line.sessionId.slice(0, 6).toUpperCase()}`,
        placedAt: line.placedAt,
        lines: [],
      }

      existing.lines.push({
        id: line.id,
        quantity: line.quantity,
        nameSnapshot: line.nameSnapshot,
        notes: line.notes,
        status: line.status,
        placedAt: line.placedAt,
        startedAt: line.startedAt,
        modifiers: modifiersByLine.get(line.id) ?? [],
      })

      groups.set(line.sessionId, existing)
    }

    // Oldest ticket first — the kitchen works the queue, not the newest thing
    // to appear.
    return [...groups.values()].sort(
      (a, b) => a.placedAt.getTime() - b.placedAt.getTime(),
    )
  })
}

const FORWARD: Record<string, OrderLineStatus[]> = {
  pending: ['preparing', 'ready'],
  preparing: ['ready'],
  ready: ['served'],
  served: [],
  voided: [],
}

/**
 * Advances a line through preparation.
 *
 * Only forwards, and only to a reachable state. `pending → ready` is allowed
 * because a drink poured in ten seconds never meaningfully passes through
 * "preparing", and forcing a second tap for it would train staff to
 * double-tap everything.
 *
 * Going backwards is refused. A line marked served and then un-served would
 * make the timestamps meaningless, and those timestamps are what any later
 * question about kitchen speed depends on.
 */
export async function advanceOrderLine(
  ctx: BranchActorContext,
  orderLineId: string,
  to: OrderLineStatus,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [line] = await tx
      .select({
        id: orderLines.id,
        status: orderLines.status,
        nameSnapshot: orderLines.nameSnapshot,
        sessionId: orderLines.sessionId,
      })
      .from(orderLines)
      .where(
        and(
          eq(orderLines.id, orderLineId),
          eq(orderLines.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!line) throw new NotFoundError('That item is not on any order.')

    if (line.status === 'voided') {
      throw new ConflictError('That item was voided and is not being made.')
    }

    if (!FORWARD[line.status].includes(to)) {
      throw new ConflictError(
        `"${line.nameSnapshot}" is already ${line.status} and cannot go back to ${to}.`,
      )
    }

    const now = new Date()

    await tx
      .update(orderLines)
      .set({
        status: to,
        ...(to === 'preparing' ? { startedAt: now } : {}),
        // A line jumped straight to ready still records when work began, so
        // preparation time is never a null nobody can explain.
        ...(to === 'ready'
          ? { readyAt: now, ...(line.status === 'pending' ? { startedAt: now } : {}) }
          : {}),
        ...(to === 'served' ? { servedAt: now } : {}),
      })
      .where(eq(orderLines.id, orderLineId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: `kitchen.line_${to}`,
      entityType: 'order_line',
      entityId: orderLineId,
      before: { status: line.status },
      after: { status: to },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export interface StationRow {
  id: string
  name: string
  kind: 'food' | 'beverage' | 'dessert' | 'other'
  displayOrder: number
  isDefault: boolean
  isActive: boolean
}

export async function listStations(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<StationRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: kitchenStations.id,
        name: kitchenStations.name,
        kind: kitchenStations.kind,
        displayOrder: kitchenStations.displayOrder,
        isDefault: kitchenStations.isDefault,
        isActive: kitchenStations.isActive,
      })
      .from(kitchenStations)
      .where(
        and(
          eq(kitchenStations.restaurantId, restaurantId),
          eq(kitchenStations.branchId, branchId),
        ),
      )
      .orderBy(asc(kitchenStations.displayOrder), asc(kitchenStations.name)),
  )
}

export async function createStation(
  ctx: BranchActorContext,
  branchId: string,
  input: {
    name: string
    kind: 'food' | 'beverage' | 'dessert' | 'other'
    displayOrder: number
    isDefault: boolean
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [clash] = await tx
      .select({ id: kitchenStations.id })
      .from(kitchenStations)
      .where(
        and(
          eq(kitchenStations.branchId, branchId),
          eq(kitchenStations.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(
        `This branch already has a station called "${input.name}".`,
      )
    }

    const [created] = await tx
      .insert(kitchenStations)
      .values({
        restaurantId: ctx.restaurantId,
        branchId,
        name: input.name,
        kind: input.kind,
        displayOrder: input.displayOrder,
        isDefault: input.isDefault,
      })
      .returning({ id: kitchenStations.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'kitchen.station_created',
      entityType: 'kitchen_station',
      entityId: created.id,
      after: { branchId, name: input.name, kind: input.kind },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}
