import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { billSplitShares, billSplits } from '@/lib/db/schema'
import { requireDiner } from '@/modules/session/diner'

/**
 * What this diner owes, once staff have locked a split.
 *
 * Returns every share on the table, not only the caller's — seeing what
 * everyone owes is the point of splitting a bill together, and the
 * `bill_split_shares_member_read` policy scopes it to this session anyway.
 *
 * Null when nothing has been split yet, which the UI reads as "the bill has
 * not been divided" rather than an error.
 */
export const GET = withRoute(async () => {
  const result = await requireDiner(async (tx, diner) => {
    const [split] = await tx
      .select({
        id: billSplits.id,
        strategy: billSplits.strategy,
        billTotalMinor: billSplits.billTotalMinor,
      })
      .from(billSplits)
      .where(
        and(
          eq(billSplits.sessionId, diner.sessionId),
          eq(billSplits.status, 'locked'),
        ),
      )
      .limit(1)

    if (!split) return { split: null, shares: [], yourShare: null }

    const shares = await tx
      .select({
        id: billSplitShares.id,
        memberId: billSplitShares.memberId,
        displayName: billSplitShares.displayNameSnapshot,
        totalMinor: billSplitShares.totalMinor,
        lineBreakdown: billSplitShares.lineBreakdown,
      })
      .from(billSplitShares)
      .where(eq(billSplitShares.splitId, split.id))

    return {
      split,
      shares,
      yourShare: shares.find((s) => s.memberId === diner.memberId) ?? null,
    }
  })

  return NextResponse.json(result)
})
