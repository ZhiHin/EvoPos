import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { rotateTableQr } from '@/modules/table/table.service'
import { qrPayloadUrl } from '@/modules/table/qr'

interface RouteContext {
  params: Promise<{ tableId: string }>
}

/**
 * Rotation only.
 *
 * There is deliberately no GET returning the current token: the table list
 * already carries it for members permitted to see it, and a dedicated read
 * endpoint would be one more surface guarding a value that names a physical
 * table.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('table.rotate_qr')
    const { tableId } = await params

    const { qrToken } = await rotateTableQr(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      tableId,
    )

    return NextResponse.json({ qrToken, url: qrPayloadUrl(qrToken) })
  },
)
