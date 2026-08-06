import { and, eq } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import { floors } from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { findBranchIn } from '@/modules/branch/branch.repository'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { findFloorIn, listFloors, type FloorSummary } from './floor.repository'
import type { CreateFloorInput, UpdateFloorInput } from './floor.validation'

export { listFloors }
export type { FloorSummary }

export async function createFloor(
  ctx: BranchActorContext,
  branchId: string,
  input: CreateFloorInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    // Confirms the branch exists *and* belongs to this tenant. 404, not 403.
    const branch = await findBranchIn(tx, ctx.restaurantId, branchId)
    if (!branch) throw new NotFoundError('Branch not found.')

    const [existing] = await tx
      .select({ id: floors.id })
      .from(floors)
      .where(and(eq(floors.branchId, branchId), eq(floors.name, input.name)))
      .limit(1)

    if (existing) {
      throw new ConflictError(
        `This branch already has a floor called "${input.name}".`,
      )
    }

    const [created] = await tx
      .insert(floors)
      .values({
        restaurantId: ctx.restaurantId,
        branchId,
        name: input.name,
        displayOrder: input.displayOrder,
      })
      .returning({ id: floors.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'floor.created',
      entityType: 'floor',
      entityId: created.id,
      after: { branchId, name: input.name },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function updateFloor(
  ctx: BranchActorContext,
  floorId: string,
  input: UpdateFloorInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findFloorIn(tx, ctx.restaurantId, floorId)
    if (!existing) throw new NotFoundError('Floor not found.')

    if (input.name && input.name !== existing.name) {
      const [clash] = await tx
        .select({ id: floors.id })
        .from(floors)
        .where(
          and(
            eq(floors.branchId, existing.branchId),
            eq(floors.name, input.name),
          ),
        )
        .limit(1)

      if (clash) {
        throw new ConflictError(
          `This branch already has a floor called "${input.name}".`,
        )
      }
    }

    await tx
      .update(floors)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.displayOrder !== undefined
          ? { displayOrder: input.displayOrder }
          : {}),
      })
      .where(
        and(eq(floors.id, floorId), eq(floors.restaurantId, ctx.restaurantId)),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'floor.updated',
      entityType: 'floor',
      entityId: floorId,
      before: existing,
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Hard delete, unlike branches.
 *
 * A floor is a grouping label with no financial history attached. Tables
 * reference it with `ON DELETE SET NULL`, so deleting a floor leaves its
 * tables intact and unassigned rather than destroying them — losing the label
 * should not lose the furniture.
 */
export async function deleteFloor(
  ctx: BranchActorContext,
  floorId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findFloorIn(tx, ctx.restaurantId, floorId)
    if (!existing) throw new NotFoundError('Floor not found.')

    await tx
      .delete(floors)
      .where(
        and(eq(floors.id, floorId), eq(floors.restaurantId, ctx.restaurantId)),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'floor.deleted',
      entityType: 'floor',
      entityId: floorId,
      before: existing,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
