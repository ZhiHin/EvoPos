import { and, asc, eq } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import { floors } from '@/lib/db/schema'

export interface FloorSummary {
  id: string
  branchId: string
  name: string
  displayOrder: number
}

const SUMMARY_COLUMNS = {
  id: floors.id,
  branchId: floors.branchId,
  name: floors.name,
  displayOrder: floors.displayOrder,
} as const

export async function listFloors(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<FloorSummary[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select(SUMMARY_COLUMNS)
      .from(floors)
      .where(
        and(
          eq(floors.restaurantId, restaurantId),
          eq(floors.branchId, branchId),
        ),
      )
      .orderBy(asc(floors.displayOrder), asc(floors.name)),
  )
}

export async function findFloorIn(
  tx: Transaction,
  restaurantId: string,
  floorId: string,
): Promise<FloorSummary | null> {
  const [row] = await tx
    .select(SUMMARY_COLUMNS)
    .from(floors)
    .where(and(eq(floors.id, floorId), eq(floors.restaurantId, restaurantId)))
    .limit(1)

  return row ?? null
}
