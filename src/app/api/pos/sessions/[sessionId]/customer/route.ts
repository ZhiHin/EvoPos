import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  attachCustomerToSession,
  detachCustomerFromSession,
} from '@/modules/crm/customer.service'
import { attachCustomerSchema } from '@/modules/reservation/reservation.validation'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/**
 * Attaches a member to a bill.
 *
 * This is what makes loyalty accrue at settlement — the accrual has existed
 * since Phase 9 and had no customer to award points to until now.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('customer.view')
    const { sessionId } = await params
    const input = attachCustomerSchema.parse(await readJson(request))

    await attachCustomerToSession(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      sessionId,
      input.customerId,
    )

    return NextResponse.json({ ok: true }, { status: 201 })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('customer.view')
    const { sessionId } = await params

    await detachCustomerFromSession(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      sessionId,
    )

    return NextResponse.json({ ok: true })
  },
)
