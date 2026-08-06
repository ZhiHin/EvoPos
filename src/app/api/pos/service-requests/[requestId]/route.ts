import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { resolveServiceRequest } from '@/modules/pos/pos.service'

interface RouteContext {
  params: Promise<{ requestId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('service.resolve')
    const { requestId } = await params

    await resolveServiceRequest(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      requestId,
    )

    return NextResponse.json({ ok: true })
  },
)
