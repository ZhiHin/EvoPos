import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { removeDiscount } from '@/modules/pos/pos.service'

interface RouteContext {
  params: Promise<{ discountId: string }>
}

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('discount.remove')
    const { discountId } = await params

    await removeDiscount(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      discountId,
    )

    return NextResponse.json({ ok: true })
  },
)
