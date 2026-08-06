import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { openSessionForTable } from '@/modules/session/session.service'

interface RouteContext {
  params: Promise<{ tableId: string }>
}

/** Seats guests before anyone scans. Idempotent: re-opening joins the live one. */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('session.open')
    const { tableId } = await params

    const body = (await readJson(request).catch(() => ({}))) as {
      guestCount?: number
    }

    const result = await openSessionForTable(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      tableId,
      typeof body.guestCount === 'number' ? body.guestCount : undefined,
    )

    return NextResponse.json(result, { status: 201 })
  },
)
