import { and, asc, eq } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import { branches } from '@/lib/db/schema'

export interface BranchSummary {
  id: string
  name: string
  code: string
  city: string | null
  phone: string | null
  status: 'active' | 'inactive'
  timezone: string | null
  createdAt: Date
}

const SUMMARY_COLUMNS = {
  id: branches.id,
  name: branches.name,
  code: branches.code,
  city: branches.city,
  phone: branches.phone,
  status: branches.status,
  timezone: branches.timezone,
  createdAt: branches.createdAt,
} as const

export async function listBranches(
  restaurantId: string,
  userId: string,
): Promise<BranchSummary[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select(SUMMARY_COLUMNS)
      .from(branches)
      .where(eq(branches.restaurantId, restaurantId))
      .orderBy(asc(branches.name)),
  )
}

/**
 * Reads one branch inside an existing transaction.
 *
 * The `restaurantId` predicate is redundant with the RLS policy on purpose:
 * if this query is ever refactored wrongly, the database still refuses to
 * return another tenant's row. The integration suite proves that claim
 * rather than assuming it.
 */
export async function findBranchIn(
  tx: Transaction,
  restaurantId: string,
  branchId: string,
): Promise<BranchSummary | null> {
  const [row] = await tx
    .select(SUMMARY_COLUMNS)
    .from(branches)
    .where(
      and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId)),
    )
    .limit(1)

  return row ?? null
}

export async function findBranchByCodeIn(
  tx: Transaction,
  restaurantId: string,
  code: string,
): Promise<{ id: string } | null> {
  const [row] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(
      and(eq(branches.restaurantId, restaurantId), eq(branches.code, code)),
    )
    .limit(1)

  return row ?? null
}
