import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { withTenant } from '@/lib/db'
import { promotions } from '@/lib/db/schema'
import { ConflictError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { createPromotionSchema } from '@/modules/promotion/promotion.validation'
import { and, eq } from 'drizzle-orm'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('promotion.create')
  const input = createPromotionSchema.parse(await readJson(request))

  const actor = {
    restaurantId: ctx.tenant.restaurantId,
    userId: ctx.user.id,
    ...getRequestMetadata(request),
  }

  const created = await withTenant(actor, async (tx) => {
    const [clash] = await tx
      .select({ id: promotions.id })
      .from(promotions)
      .where(
        and(
          eq(promotions.restaurantId, actor.restaurantId),
          eq(promotions.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(
        `A promotion called "${input.name}" already exists.`,
      )
    }

    const [row] = await tx
      .insert(promotions)
      .values({
        restaurantId: actor.restaurantId,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        value: input.value,
        priority: input.priority,
        isStackable: input.isStackable,
        isActive: input.isActive,
        validFrom: input.validFrom ? new Date(input.validFrom) : null,
        validTo: input.validTo ? new Date(input.validTo) : null,
        daysOfWeek: input.daysOfWeek,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        branchIds: input.branchIds,
        minSpendMinor: input.minSpend ?? 0,
        categoryIds: input.categoryIds,
        menuItemIds: input.menuItemIds,
        minQuantity: input.minQuantity,
        requiredTierId: input.requiredTierId ?? null,
        requiresVoucher: input.requiresVoucher,
        maxUsageTotal: input.maxUsageTotal ?? null,
      })
      .returning({ id: promotions.id })

    await recordAuditIn(tx, {
      restaurantId: actor.restaurantId,
      actorUserId: actor.userId,
      action: 'promotion.created',
      entityType: 'promotion',
      entityId: row.id,
      after: { name: input.name, kind: input.kind, value: input.value },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    })

    return row
  })

  return NextResponse.json(created, { status: 201 })
})
