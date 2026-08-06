import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { lockSplit } from '@/modules/bill/bill.service'
import { lockSplitSchema } from '@/modules/bill/bill.validation'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/**
 * Locks a split, freezing what each person owes.
 *
 * The body carries the bill total the cashier was looking at. If an order
 * landed in between, the service refuses rather than committing customers to
 * amounts derived from a bill nobody saw.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('bill.lock')
    const { sessionId } = await params
    const input = lockSplitSchema.parse(await readJson(request))

    const result = await lockSplit(
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
