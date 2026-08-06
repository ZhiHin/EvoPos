import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { applyDiscount } from '@/modules/pos/pos.service'
import { applyDiscountSchema } from '@/modules/pos/pos.validation'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('discount.apply')
    const { sessionId } = await params
    const input = applyDiscountSchema.parse(await readJson(request))

    const result = await applyDiscount(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      sessionId,
      input,
    )

    return NextResponse.json(result, { status: 201 })
  },
)
