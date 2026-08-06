import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { recordCount } from '@/modules/inventory/inventory.service'
import { countSchema } from '@/modules/inventory/inventory.validation'

/**
 * Records a physical count.
 *
 * Takes what is on the shelf, not the difference — the person holding the
 * clipboard should not be doing subtraction under time pressure, because the
 * mistakes go straight into the books.
 */
export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('stock.count')
  const input = countSchema.parse(await readJson(request))

  const result = await recordCount(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input.branchId,
    input.ingredientId,
    input.counted,
    input.reason,
  )

  return NextResponse.json(result, { status: 201 })
})
