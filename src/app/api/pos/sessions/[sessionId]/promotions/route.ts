import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { applyPromotions } from '@/modules/promotion/promotion.service'
import { applyPromotionsSchema } from '@/modules/promotion/promotion.validation'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/**
 * Re-evaluates and applies automatic promotions to a bill.
 *
 * Everything is recomputed server-side. A discount arriving from a browser is
 * a request, not a fact — the same rule prices and splits already follow.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('promotion.view')
    const { sessionId } = await params
    const input = applyPromotionsSchema.parse(await readJson(request))

    const applied = await applyPromotions(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      sessionId,
      input.customerId ?? null,
      input.customerTierId ?? null,
    )

    return NextResponse.json({ applied })
  },
)
