import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { issueRefund } from '@/modules/payment/payment.service'
import { refundSchema } from '@/modules/payment/payment.validation'

interface RouteContext {
  params: Promise<{ paymentId: string }>
}

/** Refunding is its own permission — returning money is not taking it. */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('refund.issue')
    const { paymentId } = await params
    const input = refundSchema.parse(await readJson(request))

    const result = await issueRefund(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      paymentId,
      input,
    )

    return NextResponse.json(result, { status: 201 })
  },
)
