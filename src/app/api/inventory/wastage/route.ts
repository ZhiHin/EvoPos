import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { recordWastage } from '@/modules/inventory/inventory.service'
import { wastageSchema } from '@/modules/inventory/inventory.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('stock.waste')
  const input = wastageSchema.parse(await readJson(request))

  await recordWastage(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input.branchId,
    input.ingredientId,
    input.quantity,
    input.reason,
  )

  return NextResponse.json({ ok: true }, { status: 201 })
})
