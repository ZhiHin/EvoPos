import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  deleteEndpoint,
  listDeliveries,
  reactivateEndpoint,
} from '@/modules/integration/webhook.service'

interface RouteContext {
  params: Promise<{ endpointId: string }>
}

/** Recent attempts, so a customer can see why their endpoint is not firing. */
export const GET = withRoute(
  async (_request: Request, { params }: RouteContext) => {
    const ctx = await requirePermission('integration.view')
    const { endpointId } = await params

    return NextResponse.json(
      await listDeliveries(
        ctx.tenant.restaurantId,
        ctx.user.id,
        endpointId,
      ),
    )
  },
)

/** Brings a disabled endpoint back, once its owner has fixed it. */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('integration.manage')
    const { endpointId } = await params

    await reactivateEndpoint(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      endpointId,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('integration.manage')
    const { endpointId } = await params

    await deleteEndpoint(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      endpointId,
    )

    return NextResponse.json({ ok: true })
  },
)
