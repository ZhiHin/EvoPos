import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  adjustPoints,
  readCustomer,
  redeemPoints,
} from '@/modules/promotion/loyalty.service'
import { adjustPointsSchema } from '@/modules/promotion/promotion.validation'

interface RouteContext {
  params: Promise<{ customerId: string }>
}

export const GET = withRoute(
  async (_request: Request, { params }: RouteContext) => {
    const ctx = await requirePermission('customer.view')
    const { customerId } = await params

    return NextResponse.json(
      await readCustomer(ctx.tenant.restaurantId, ctx.user.id, customerId),
    )
  },
)

/**
 * Moves points by a signed amount.
 *
 * A negative figure is a spend and needs `loyalty.adjust`, because taking
 * points away is the direction that can be used to hide a mistake — or cover
 * one up. A positive figure is a grant and needs the same permission for the
 * same reason: it creates value out of nothing.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('loyalty.adjust')
    const { customerId } = await params
    const input = adjustPointsSchema.parse(await readJson(request))

    const actor = {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    }

    await adjustPoints(actor, customerId, input.points, input.reason)

    return NextResponse.json(
      await readCustomer(ctx.tenant.restaurantId, ctx.user.id, customerId),
    )
  },
)

/**
 * Spends points as a reward.
 *
 * Separate from the adjustment above because it is a different act with a
 * different permission: a cashier hands over a free coffee, they do not
 * rewrite the ledger.
 */
export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('loyalty.manage')
    const { customerId } = await params
    const input = adjustPointsSchema.parse(await readJson(request))

    await redeemPoints(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      customerId,
      input.points,
      input.reason,
    )

    return NextResponse.json(
      await readCustomer(ctx.tenant.restaurantId, ctx.user.id, customerId),
    )
  },
)
