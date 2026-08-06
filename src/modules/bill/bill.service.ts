import { and, asc, eq, isNull, ne } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  billSplitShares,
  billSplits,
  diningSessionMembers,
  diningSessions,
  orderLines,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { computeSessionTotals } from '@/modules/pos/pos.service'
import {
  assertSplitBalances,
  computeSplit,
  type SplitLine,
  type SplitParticipant,
  type SplitResult,
  type SplitStrategy,
} from './split'
import type { LockSplitInput, SplitStrategyInput } from './bill.validation'

/**
 * Smart Bill service.
 *
 * Loads a session's lines, participants and totals, hands them to the pure
 * engine, and persists the result when a cashier locks it.
 */

function toEngineStrategy(input: SplitStrategyInput): SplitStrategy {
  switch (input.kind) {
    case 'by_owner':
      return { kind: 'by_owner' }
    case 'even':
      return { kind: 'even' }
    case 'by_percentage':
      return { kind: 'by_percentage', weights: input.percentages }
    case 'by_item':
      return { kind: 'by_item', assignments: input.assignments }
  }
}

interface SessionSplitInputs {
  lines: SplitLine[]
  participants: SplitParticipant[]
}

async function loadSplitInputs(
  tx: Transaction,
  sessionId: string,
): Promise<SessionSplitInputs> {
  const lines = await tx
    .select({
      lineId: orderLines.id,
      memberId: orderLines.memberId,
      nameSnapshot: orderLines.nameSnapshot,
      quantity: orderLines.quantity,
      lineTotalMinor: orderLines.lineTotalMinor,
    })
    .from(orderLines)
    .where(
      and(eq(orderLines.sessionId, sessionId), ne(orderLines.status, 'voided')),
    )
    .orderBy(asc(orderLines.placedAt))

  /**
   * Only members still at the table participate. Someone who has already
   * settled and left is not given a second share — their portion was locked
   * in a previous split, and including them again would double-charge them.
   */
  const participants = await tx
    .select({
      memberId: diningSessionMembers.id,
      displayName: diningSessionMembers.displayName,
    })
    .from(diningSessionMembers)
    .where(
      and(
        eq(diningSessionMembers.sessionId, sessionId),
        isNull(diningSessionMembers.leftAt),
      ),
    )
    .orderBy(asc(diningSessionMembers.joinedAt))

  return { lines, participants }
}

/**
 * Computes a split without saving anything.
 *
 * The screen a cashier adjusts while the customers argue about who had the
 * satay. Nothing here changes state, so it can be called freely on every
 * keystroke.
 */
export async function previewSplit(
  restaurantId: string,
  userId: string,
  sessionId: string,
  strategyInput: SplitStrategyInput,
): Promise<SplitResult & { totals: Awaited<ReturnType<typeof computeSessionTotals>> }> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const [session] = await tx
      .select({ id: diningSessions.id })
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.id, sessionId),
          eq(diningSessions.restaurantId, restaurantId),
        ),
      )
      .limit(1)

    if (!session) throw new NotFoundError('Session not found.')

    const [{ lines, participants }, totals] = await Promise.all([
      loadSplitInputs(tx, sessionId),
      computeSessionTotals(tx, restaurantId, sessionId),
    ])

    const result = computeSplit(
      lines,
      participants,
      totals,
      toEngineStrategy(strategyInput),
    )

    assertSplitBalances(result, totals)

    return { ...result, totals }
  })
}

/**
 * Locks a split, freezing what each person owes.
 *
 * Two guards, both about a bill moving underneath someone:
 *
 * 1. `expectedBillTotalMinor` must match the live total. If an order landed
 *    while the cashier was arranging the split, they were looking at a
 *    different bill and must see the new one before committing anyone to a
 *    number.
 * 2. Only one locked split may exist per session, enforced by a partial
 *    unique index rather than a check — two cashiers splitting the same table
 *    concurrently would otherwise produce two authoritative-looking answers.
 */
export async function lockSplit(
  ctx: BranchActorContext,
  sessionId: string,
  input: LockSplitInput,
): Promise<{ splitId: string; shares: SplitResult['shares'] }> {
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
    if (session.status === 'closed' || session.status === 'abandoned') {
      throw new ConflictError('That bill has already been settled.')
    }

    const [{ lines, participants }, totals] = await Promise.all([
      loadSplitInputs(tx, sessionId),
      computeSessionTotals(tx, ctx.restaurantId, sessionId),
    ])

    if (totals.totalMinor !== input.expectedBillTotalMinor) {
      throw new ConflictError(
        'The bill changed while you were splitting it — something was added or voided. Review the new total and split again.',
      )
    }

    const result = computeSplit(
      lines,
      participants,
      totals,
      toEngineStrategy(input.strategy),
    )

    // Belt and braces. A rounding regression must fail here, loudly, rather
    // than on a customer's card.
    assertSplitBalances(result, totals)

    const inserted = await tx
      .insert(billSplits)
      .values({
        restaurantId: ctx.restaurantId,
        sessionId,
        strategy: input.strategy.kind,
        billTotalMinor: totals.totalMinor,
        lockedByUserId: ctx.userId,
      })
      .onConflictDoNothing()
      .returning({ id: billSplits.id })

    if (inserted.length === 0) {
      throw new ConflictError(
        'This bill has already been split. Void the existing split before creating a new one.',
      )
    }

    const splitId = inserted[0].id

    await tx.insert(billSplitShares).values(
      result.shares.map((share) => ({
        restaurantId: ctx.restaurantId,
        sessionId,
        splitId,
        memberId: share.memberId,
        displayNameSnapshot: share.displayName,
        subtotalMinor: share.subtotalMinor,
        discountMinor: share.discountMinor,
        serviceChargeMinor: share.serviceChargeMinor,
        taxMinor: share.taxMinor,
        totalMinor: share.totalMinor,
        lineBreakdown: share.lines,
      })),
    )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'bill.split_locked',
      entityType: 'bill_split',
      entityId: splitId,
      after: {
        sessionId,
        strategy: input.strategy.kind,
        billTotalMinor: totals.totalMinor,
        shares: result.shares.map((s) => ({
          name: s.displayName,
          totalMinor: s.totalMinor,
        })),
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { splitId, shares: result.shares }
  })
}

/**
 * Voids a locked split.
 *
 * The row survives with `status = 'void'` and a reason. What a customer was
 * told they owed, and who decided to change it, is exactly the history that
 * matters when a bill is disputed.
 */
export async function voidSplit(
  ctx: BranchActorContext,
  splitId: string,
  reason: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        id: billSplits.id,
        sessionId: billSplits.sessionId,
        status: billSplits.status,
        billTotalMinor: billSplits.billTotalMinor,
      })
      .from(billSplits)
      .where(
        and(
          eq(billSplits.id, splitId),
          eq(billSplits.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Split not found.')
    if (existing.status === 'void') {
      throw new ConflictError('That split has already been voided.')
    }

    await tx
      .update(billSplits)
      .set({
        status: 'void',
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason: reason,
      })
      .where(eq(billSplits.id, splitId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'bill.split_voided',
      entityType: 'bill_split',
      entityId: splitId,
      before: existing,
      after: { reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export interface LockedSplit {
  id: string
  strategy: 'by_owner' | 'even' | 'by_percentage' | 'by_item'
  billTotalMinor: number
  /** Live total now, which may exceed the locked one if orders continued. */
  currentBillTotalMinor: number
  shares: {
    id: string
    memberId: string | null
    displayName: string
    totalMinor: number
    subtotalMinor: number
    serviceChargeMinor: number
    taxMinor: number
    discountMinor: number
    lineBreakdown: {
      lineId: string
      nameSnapshot: string
      amountMinor: number
      isShared: boolean
    }[]
  }[]
}

/**
 * Reads the live split for a session, if there is one.
 *
 * Reports the current bill total alongside the locked one. A gap between them
 * means items were ordered after the split was agreed, and that difference is
 * money nobody has been asked for yet — staff need to see it, not discover it
 * at the end of the night.
 */
export async function readLockedSplit(
  tx: Transaction,
  restaurantId: string,
  sessionId: string,
): Promise<LockedSplit | null> {
  const [split] = await tx
    .select({
      id: billSplits.id,
      strategy: billSplits.strategy,
      billTotalMinor: billSplits.billTotalMinor,
    })
    .from(billSplits)
    .where(
      and(
        eq(billSplits.sessionId, sessionId),
        eq(billSplits.status, 'locked'),
      ),
    )
    .limit(1)

  if (!split) return null

  const shares = await tx
    .select({
      id: billSplitShares.id,
      memberId: billSplitShares.memberId,
      displayName: billSplitShares.displayNameSnapshot,
      totalMinor: billSplitShares.totalMinor,
      subtotalMinor: billSplitShares.subtotalMinor,
      serviceChargeMinor: billSplitShares.serviceChargeMinor,
      taxMinor: billSplitShares.taxMinor,
      discountMinor: billSplitShares.discountMinor,
      lineBreakdown: billSplitShares.lineBreakdown,
    })
    .from(billSplitShares)
    .where(eq(billSplitShares.splitId, split.id))
    .orderBy(asc(billSplitShares.createdAt))

  const totals = await computeSessionTotals(tx, restaurantId, sessionId)

  return { ...split, currentBillTotalMinor: totals.totalMinor, shares }
}

export async function readLockedSplitForStaff(
  restaurantId: string,
  userId: string,
  sessionId: string,
): Promise<LockedSplit | null> {
  return withTenant({ restaurantId, userId }, (tx) =>
    readLockedSplit(tx, restaurantId, sessionId),
  )
}
