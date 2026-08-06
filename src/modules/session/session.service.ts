import { and, eq, inArray, isNull } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  diningSessionMembers,
  diningSessions,
  diningTables,
  serviceRequests,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { resolveTableByToken } from '@/modules/table/table.repository'
import { issueDinerToken, type IssuedDinerToken } from './diner'

/**
 * Dining session lifecycle.
 *
 * A session is opened by whoever arrives first — a waiter seating guests, or
 * the first diner to scan the QR. Both paths converge on the same row.
 */

const LIVE_STATUSES = ['open', 'bill_requested'] as const

export interface JoinResult {
  sessionId: string
  memberId: string
  token: IssuedDinerToken
  table: {
    id: string
    code: string
    name: string | null
    branchName: string
    restaurantName: string
  }
  isNewSession: boolean
}

/**
 * Finds the live session for a table, or opens one.
 *
 * The insert may lose a race against another diner scanning the same QR at
 * the same moment — the partial unique index rejects the second one. That is
 * the correct outcome and is handled rather than prevented: on conflict, the
 * winner's session is re-read and joined. A check-then-insert would let both
 * succeed and split one table across two bills.
 */
async function findOrOpenSession(
  tx: Transaction,
  restaurantId: string,
  branchId: string,
  tableId: string,
  openedByUserId: string | null,
): Promise<{ id: string; isNew: boolean }> {
  const [existing] = await tx
    .select({ id: diningSessions.id })
    .from(diningSessions)
    .where(
      and(
        eq(diningSessions.tableId, tableId),
        inArray(diningSessions.status, LIVE_STATUSES),
      ),
    )
    .limit(1)

  if (existing) return { id: existing.id, isNew: false }

  const inserted = await tx
    .insert(diningSessions)
    .values({ restaurantId, branchId, tableId, openedByUserId })
    .onConflictDoNothing()
    .returning({ id: diningSessions.id })

  if (inserted.length > 0) {
    await tx
      .update(diningTables)
      .set({ status: 'occupied' })
      .where(eq(diningTables.id, tableId))

    return { id: inserted[0].id, isNew: true }
  }

  // Lost the race. The winner's session is now live; join that.
  const [winner] = await tx
    .select({ id: diningSessions.id })
    .from(diningSessions)
    .where(
      and(
        eq(diningSessions.tableId, tableId),
        inArray(diningSessions.status, LIVE_STATUSES),
      ),
    )
    .limit(1)

  if (!winner) {
    throw new ConflictError(
      'That table is being seated right now. Please try again in a moment.',
    )
  }

  return { id: winner.id, isNew: false }
}

/**
 * Joins a diner to a table by scanning its printed QR.
 *
 * Runs under tenant context, which is legitimate here in a way it never is
 * for a diner request: this is server-side code acting for the restaurant,
 * triggered by proof of physical presence at the table. Its reach is confined
 * to this one function — the token the diner walks away with grants only the
 * far narrower member context.
 */
export async function joinByQrToken(
  qrToken: string,
  displayName: string,
): Promise<JoinResult> {
  const table = await resolveTableByToken(qrToken)
  if (!table) throw new NotFoundError('That QR code is no longer valid.')

  const token = issueDinerToken()

  const result = await withTenant(
    { restaurantId: table.restaurantId, userId: null },
    async (tx) => {
      const session = await findOrOpenSession(
        tx,
        table.restaurantId,
        table.branchId,
        table.tableId,
        null,
      )

      const [member] = await tx
        .insert(diningSessionMembers)
        .values({
          restaurantId: table.restaurantId,
          sessionId: session.id,
          displayName,
          tokenHash: token.tokenHash,
          expiresAt: token.expiresAt,
        })
        .returning({ id: diningSessionMembers.id })

      await recordAuditIn(tx, {
        restaurantId: table.restaurantId,
        action: session.isNew ? 'session.opened_by_qr' : 'session.member_joined',
        entityType: 'dining_session',
        entityId: session.id,
        after: { tableCode: table.tableCode, displayName },
      })

      return { sessionId: session.id, memberId: member.id, isNew: session.isNew }
    },
  )

  return {
    sessionId: result.sessionId,
    memberId: result.memberId,
    token,
    table: {
      id: table.tableId,
      code: table.tableCode,
      name: table.tableName,
      branchName: table.branchName,
      restaurantName: table.restaurantName,
    },
    isNewSession: result.isNew,
  }
}

/** Staff-initiated open, for a waiter seating guests before anyone scans. */
export async function openSessionForTable(
  ctx: BranchActorContext,
  tableId: string,
  guestCount?: number,
): Promise<{ sessionId: string }> {
  return withTenant(ctx, async (tx) => {
    const [table] = await tx
      .select({
        id: diningTables.id,
        branchId: diningTables.branchId,
        code: diningTables.code,
      })
      .from(diningTables)
      .where(
        and(
          eq(diningTables.id, tableId),
          eq(diningTables.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!table) throw new NotFoundError('Table not found.')

    const session = await findOrOpenSession(
      tx,
      ctx.restaurantId,
      table.branchId,
      tableId,
      ctx.userId,
    )

    if (guestCount !== undefined) {
      await tx
        .update(diningSessions)
        .set({ guestCount })
        .where(eq(diningSessions.id, session.id))
    }

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'session.opened',
      entityType: 'dining_session',
      entityId: session.id,
      after: { tableCode: table.code, guestCount },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { sessionId: session.id }
  })
}

/**
 * Closes a session and frees the table.
 *
 * Members are expired rather than deleted: their names are attached to order
 * lines that remain on the closed bill, and Phase 6 needs them to explain who
 * ordered what long after everyone has left.
 */
export async function closeSession(
  ctx: BranchActorContext,
  sessionId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [session] = await tx
      .select({
        id: diningSessions.id,
        tableId: diningSessions.tableId,
        status: diningSessions.status,
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

    const now = new Date()

    await tx
      .update(diningSessions)
      .set({ status: 'closed', closedAt: now })
      .where(eq(diningSessions.id, sessionId))

    // Expiring the tokens is what actually revokes access; the cookies on
    // diners' phones are now inert.
    await tx
      .update(diningSessionMembers)
      .set({ expiresAt: now, leftAt: now })
      .where(
        and(
          eq(diningSessionMembers.sessionId, sessionId),
          isNull(diningSessionMembers.leftAt),
        ),
      )

    await tx
      .update(serviceRequests)
      .set({ status: 'resolved', resolvedAt: now, resolvedByUserId: ctx.userId })
      .where(
        and(
          eq(serviceRequests.sessionId, sessionId),
          eq(serviceRequests.status, 'open'),
        ),
      )

    // Takeaway and delivery sessions have no table to free.
    if (session.tableId) {
      await tx
        .update(diningTables)
        .set({ status: 'available' })
        .where(eq(diningTables.id, session.tableId))
    }

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'session.closed',
      entityType: 'dining_session',
      entityId: sessionId,
      before: { status: session.status },
      after: { status: 'closed' },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export interface SessionSummary {
  id: string
  /** Null for takeaway and delivery. */
  tableId: string | null
  tableCode: string | null
  type: 'dine_in' | 'takeaway' | 'delivery'
  status: 'open' | 'bill_requested' | 'closed' | 'abandoned'
  customerName: string | null
  guestCount: number | null
  openedAt: Date
  memberCount: number
  openServiceRequests: number
}

/** Live sessions for the floor view. */
export async function listLiveSessions(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<SessionSummary[]> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const sessions = await tx
      .select({
        id: diningSessions.id,
        tableId: diningSessions.tableId,
        tableCode: diningTables.code,
        type: diningSessions.type,
        status: diningSessions.status,
        customerName: diningSessions.customerName,
        guestCount: diningSessions.guestCount,
        openedAt: diningSessions.openedAt,
      })
      .from(diningSessions)
      /**
       * LEFT, not INNER. Takeaway and delivery sessions have no table, and an
       * inner join would silently drop every one of them from the floor view
       * — the orders would exist, be payable, and be invisible to staff.
       */
      .leftJoin(diningTables, eq(diningTables.id, diningSessions.tableId))
      .where(
        and(
          eq(diningSessions.restaurantId, restaurantId),
          eq(diningSessions.branchId, branchId),
          inArray(diningSessions.status, LIVE_STATUSES),
        ),
      )

    if (sessions.length === 0) return []

    const ids = sessions.map((s) => s.id)

    const [members, requests] = await Promise.all([
      tx
        .select({ sessionId: diningSessionMembers.sessionId })
        .from(diningSessionMembers)
        .where(
          and(
            inArray(diningSessionMembers.sessionId, ids),
            isNull(diningSessionMembers.leftAt),
          ),
        ),
      tx
        .select({ sessionId: serviceRequests.sessionId })
        .from(serviceRequests)
        .where(
          and(
            inArray(serviceRequests.sessionId, ids),
            eq(serviceRequests.status, 'open'),
          ),
        ),
    ])

    const countBy = (rows: { sessionId: string }[]) => {
      const map = new Map<string, number>()
      for (const row of rows) {
        map.set(row.sessionId, (map.get(row.sessionId) ?? 0) + 1)
      }
      return map
    }

    const memberCounts = countBy(members)
    const requestCounts = countBy(requests)

    return sessions.map((session) => ({
      ...session,
      memberCount: memberCounts.get(session.id) ?? 0,
      openServiceRequests: requestCounts.get(session.id) ?? 0,
    }))
  })
}
