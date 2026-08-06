import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { voidPayment } from '@/modules/payment/payment.service'
import { voidPaymentSchema } from '@/modules/payment/payment.validation'

interface RouteContext {
  params: Promise<{ paymentId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('payment.void')
    const { paymentId } = await params
    const input = voidPaymentSchema.parse(await readJson(request))

    await voidPayment(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      paymentId,
      input.reason,
    )

    return NextResponse.json({ ok: true })
  },
)
