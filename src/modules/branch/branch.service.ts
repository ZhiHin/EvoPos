import { and, eq } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import { branches } from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { assertQuota } from '@/modules/billing/billing.service'
import {
  findBranchByCodeIn,
  findBranchIn,
  listBranches,
  type BranchSummary,
} from './branch.repository'
import type { CreateBranchInput, UpdateBranchInput } from './branch.validation'

/**
 * Actor context for tenant-scoped mutations.
 *
 * Defined here rather than per-module because floors, tables and settings all
 * need exactly the same four fields; a second copy would drift.
 */
export interface BranchActorContext {
  restaurantId: string
  userId: string
  ipAddress?: string | null
  userAgent?: string | null
}

export { listBranches }
export type { BranchSummary }

export async function getBranch(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<BranchSummary> {
  const branch = await withTenant({ restaurantId, userId }, (tx) =>
    findBranchIn(tx, restaurantId, branchId),
  )

  // 404 rather than 403: a 403 would confirm this branch id exists somewhere.
  if (!branch) throw new NotFoundError('Branch not found.')
  return branch
}

export async function createBranch(
  ctx: BranchActorContext,
  input: CreateBranchInput,
): Promise<{ id: string }> {
  /**
   * The plan's ceiling, checked before anything is written.
   *
   * Here in the service rather than in the route, so the same limit holds
   * whether a branch is created from the UI, from an API key, or from an
   * import script somebody writes next year.
   */
  await assertQuota(ctx, 'branches')

  return withTenant(ctx, async (tx) => {
    /**
     * Checked explicitly as well as by the unique index. The index is the
     * real guarantee, but a duplicate-key error surfaces as an opaque 500,
     * and "code KL01 is already used" is what the person filling in the form
     * needs to read.
     */
    const clash = await findBranchByCodeIn(tx, ctx.restaurantId, input.code)
    if (clash) {
      throw new ConflictError(
        `Branch code "${input.code}" is already used by another branch.`,
      )
    }

    const [created] = await tx
      .insert(branches)
      .values({
        restaurantId: ctx.restaurantId,
        name: input.name,
        code: input.code,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        postalCode: input.postalCode ?? null,
        country: input.country ?? null,
        phone: input.phone ?? null,
        timezone: input.timezone || null,
      })
      .returning({ id: branches.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'branch.created',
      entityType: 'branch',
      entityId: created.id,
      after: { name: input.name, code: input.code },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function updateBranch(
  ctx: BranchActorContext,
  branchId: string,
  input: UpdateBranchInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findBranchIn(tx, ctx.restaurantId, branchId)
    if (!existing) throw new NotFoundError('Branch not found.')

    if (input.code && input.code !== existing.code) {
      const clash = await findBranchByCodeIn(tx, ctx.restaurantId, input.code)
      if (clash) {
        throw new ConflictError(
          `Branch code "${input.code}" is already used by another branch.`,
        )
      }
    }

    await tx
      .update(branches)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.addressLine1 !== undefined
          ? { addressLine1: input.addressLine1 || null }
          : {}),
        ...(input.addressLine2 !== undefined
          ? { addressLine2: input.addressLine2 || null }
          : {}),
        ...(input.city !== undefined ? { city: input.city || null } : {}),
        ...(input.state !== undefined ? { state: input.state || null } : {}),
        ...(input.postalCode !== undefined
          ? { postalCode: input.postalCode || null }
          : {}),
        ...(input.country !== undefined
          ? { country: input.country || null }
          : {}),
        ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
        ...(input.timezone !== undefined
          ? { timezone: input.timezone || null }
          : {}),
      })
      .where(
        and(
          eq(branches.id, branchId),
          eq(branches.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'branch.updated',
      entityType: 'branch',
      entityId: branchId,
      before: existing,
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Deactivates rather than deletes.
 *
 * A branch is referenced by memberships, and will be referenced by orders and
 * payments from Phase 5. Deleting one would either cascade away financial
 * history or fail on a foreign key. Neither is what "close this branch"
 * means — the branch stops operating, its records stay.
 */
export async function deactivateBranch(
  ctx: BranchActorContext,
  branchId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findBranchIn(tx, ctx.restaurantId, branchId)
    if (!existing) throw new NotFoundError('Branch not found.')

    await tx
      .update(branches)
      .set({ status: 'inactive' })
      .where(
        and(
          eq(branches.id, branchId),
          eq(branches.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'branch.deactivated',
      entityType: 'branch',
      entityId: branchId,
      before: { status: existing.status },
      after: { status: 'inactive' },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
