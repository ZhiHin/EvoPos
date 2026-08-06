import { and, eq } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import { diningTables } from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { findBranchIn } from '@/modules/branch/branch.repository'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { findFloorIn } from '@/modules/floor/floor.repository'
import { generateQrToken } from './qr'
import {
  findTableIn,
  listTables,
  resolveTableByToken,
  type TableSummary,
} from './table.repository'
import type { CreateTableInput, UpdateTableInput } from './table.validation'

export { listTables, resolveTableByToken }
export type { TableSummary }

export async function createTable(
  ctx: BranchActorContext,
  branchId: string,
  input: CreateTableInput,
): Promise<{ id: string; qrToken: string }> {
  return withTenant(ctx, async (tx) => {
    const branch = await findBranchIn(tx, ctx.restaurantId, branchId)
    if (!branch) throw new NotFoundError('Branch not found.')

    if (input.floorId) {
      const floor = await findFloorIn(tx, ctx.restaurantId, input.floorId)
      /**
       * The branch check matters as much as the existence check. RLS confines
       * the floor to this tenant but says nothing about which branch it is
       * on, so without this a Bangsar table could be filed under a Penang
       * floor — same restaurant, wrong building.
       */
      if (!floor || floor.branchId !== branchId) {
        throw new NotFoundError('Floor not found in this branch.')
      }
    }

    const [clash] = await tx
      .select({ id: diningTables.id })
      .from(diningTables)
      .where(
        and(
          eq(diningTables.branchId, branchId),
          eq(diningTables.code, input.code),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(`This branch already has a table "${input.code}".`)
    }

    const qrToken = generateQrToken()

    const [created] = await tx
      .insert(diningTables)
      .values({
        restaurantId: ctx.restaurantId,
        branchId,
        floorId: input.floorId ?? null,
        code: input.code,
        name: input.name ?? null,
        capacity: input.capacity,
        qrToken,
        positionX: input.positionX ?? null,
        positionY: input.positionY ?? null,
      })
      .returning({ id: diningTables.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'table.created',
      entityType: 'table',
      entityId: created.id,
      // No qrToken in the payload — the audit trail is undeletable by design,
      // and a live capability does not belong in a table nothing can redact.
      after: { branchId, code: input.code, capacity: input.capacity },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id, qrToken }
  })
}

export async function updateTable(
  ctx: BranchActorContext,
  tableId: string,
  input: UpdateTableInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findTableIn(tx, ctx.restaurantId, tableId)
    if (!existing) throw new NotFoundError('Table not found.')

    if (input.floorId) {
      const floor = await findFloorIn(tx, ctx.restaurantId, input.floorId)
      if (!floor || floor.branchId !== existing.branchId) {
        throw new NotFoundError('Floor not found in this branch.')
      }
    }

    if (input.code && input.code !== existing.code) {
      const [clash] = await tx
        .select({ id: diningTables.id })
        .from(diningTables)
        .where(
          and(
            eq(diningTables.branchId, existing.branchId),
            eq(diningTables.code, input.code),
          ),
        )
        .limit(1)

      if (clash) {
        throw new ConflictError(
          `This branch already has a table "${input.code}".`,
        )
      }
    }

    await tx
      .update(diningTables)
      .set({
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.name !== undefined ? { name: input.name || null } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.floorId !== undefined ? { floorId: input.floorId } : {}),
        ...(input.positionX !== undefined
          ? { positionX: input.positionX }
          : {}),
        ...(input.positionY !== undefined
          ? { positionY: input.positionY }
          : {}),
      })
      .where(
        and(
          eq(diningTables.id, tableId),
          eq(diningTables.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'table.updated',
      entityType: 'table',
      entityId: tableId,
      before: { ...existing, qrToken: undefined },
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Issues a new token, invalidating every printed sticker for this table.
 *
 * Separate from `updateTable` and behind its own permission because the
 * consequence is physical: someone has to walk the floor and replace a
 * sticker. It must never happen as a side effect of editing a capacity.
 */
export async function rotateTableQr(
  ctx: BranchActorContext,
  tableId: string,
): Promise<{ qrToken: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await findTableIn(tx, ctx.restaurantId, tableId)
    if (!existing) throw new NotFoundError('Table not found.')

    const qrToken = generateQrToken()
    const rotatedAt = new Date()

    await tx
      .update(diningTables)
      .set({ qrToken, qrRotatedAt: rotatedAt })
      .where(
        and(
          eq(diningTables.id, tableId),
          eq(diningTables.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'table.qr_rotated',
      entityType: 'table',
      entityId: tableId,
      // Records that rotation happened, never which token. Both the old and
      // the new value stay out of an undeletable table.
      after: { code: existing.code, rotatedAt: rotatedAt.toISOString() },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { qrToken }
  })
}

export async function deleteTable(
  ctx: BranchActorContext,
  tableId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findTableIn(tx, ctx.restaurantId, tableId)
    if (!existing) throw new NotFoundError('Table not found.')

    await tx
      .delete(diningTables)
      .where(
        and(
          eq(diningTables.id, tableId),
          eq(diningTables.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'table.deleted',
      entityType: 'table',
      entityId: tableId,
      before: { ...existing, qrToken: undefined },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
