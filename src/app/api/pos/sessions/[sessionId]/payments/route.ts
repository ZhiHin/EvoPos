import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { takePayment } from '@/modules/payment/payment.service'
import { takePaymentSchema } from '@/modules/payment/payment.validation'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/**
 * Takes a payment.
 *
 * Idempotent on the client-supplied key: a retry returns the original payment
 * with `wasReplay: true` rather than charging again. The 201 is therefore
 * safe to retry, which is the point.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('payment.take')
    const { sessionId } = await params
    const input = takePaymentSchema.parse(await readJson(request))

    const result = await takePayment(
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
