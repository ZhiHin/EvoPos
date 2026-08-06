import { and, asc, eq } from 'drizzle-orm'

import { withQrToken, withTenant, type Transaction } from '@/lib/db'
import { branches, diningTables, restaurants } from '@/lib/db/schema'
import { isWellFormedQrToken } from './qr'

export interface TableSummary {
  id: string
  branchId: string
  floorId: string | null
  code: string
  name: string | null
  capacity: number
  status: 'available' | 'occupied' | 'reserved' | 'out_of_service'
  qrToken: string
  positionX: number | null
  positionY: number | null
}

export interface ScannedTable {
  tableId: string
  tableCode: string
  tableName: string | null
  branchName: string
  restaurantName: string
}

const SUMMARY_COLUMNS = {
  id: diningTables.id,
  branchId: diningTables.branchId,
  floorId: diningTables.floorId,
  code: diningTables.code,
  name: diningTables.name,
  capacity: diningTables.capacity,
  status: diningTables.status,
  qrToken: diningTables.qrToken,
  positionX: diningTables.positionX,
  positionY: diningTables.positionY,
} as const

export async function listTables(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<TableSummary[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select(SUMMARY_COLUMNS)
      .from(diningTables)
      .where(
        and(
          eq(diningTables.restaurantId, restaurantId),
          eq(diningTables.branchId, branchId),
        ),
      )
      .orderBy(asc(diningTables.code)),
  )
}

export async function findTableIn(
  tx: Transaction,
  restaurantId: string,
  tableId: string,
): Promise<TableSummary | null> {
  const [row] = await tx
    .select(SUMMARY_COLUMNS)
    .from(diningTables)
    .where(
      and(
        eq(diningTables.id, tableId),
        eq(diningTables.restaurantId, restaurantId),
      ),
    )
    .limit(1)

  return row ?? null
}

/**
 * Resolves a scanned QR token to its table.
 *
 * Runs with no tenant and no actor. The only reason this returns anything is
 * the three `*_qr_lookup` policies, each scoped to the single row bearing
 * this token — so a valid token yields one table and an invalid one yields
 * nothing. There is no query shape here that could list tables, which is what
 * makes the endpoint safe to expose unauthenticated.
 */
export async function resolveTableByToken(
  token: string,
): Promise<ScannedTable | null> {
  // Cheap rejection before opening a transaction.
  if (!isWellFormedQrToken(token)) return null

  return withQrToken(token, async (tx) => {
    const [row] = await tx
      .select({
        tableId: diningTables.id,
        tableCode: diningTables.code,
        tableName: diningTables.name,
        branchName: branches.name,
        restaurantName: restaurants.name,
      })
      .from(diningTables)
      .innerJoin(branches, eq(branches.id, diningTables.branchId))
      .innerJoin(restaurants, eq(restaurants.id, diningTables.restaurantId))
      .where(eq(diningTables.qrToken, token))
      .limit(1)

    return row ?? null
  })
}
