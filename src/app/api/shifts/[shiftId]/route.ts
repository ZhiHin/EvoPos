import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { deleteShift } from '@/modules/workforce/workforce.service'

interface RouteContext {
  params: Promise<{ shiftId: string }>
}

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('shift.manage')
    const { shiftId } = await params

    await deleteShift(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      shiftId,
    )

    return NextResponse.json({ ok: true })
  },
)
