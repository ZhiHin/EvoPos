import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { redeemVoucher } from '@/modules/promotion/promotion.service'
import { redeemVoucherSchema } from '@/modules/promotion/promotion.validation'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('voucher.redeem')
    const { sessionId } = await params
    const input = redeemVoucherSchema.parse(await readJson(request))

    const result = await redeemVoucher(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      sessionId,
      input.code,
    )

    return NextResponse.json(result, { status: 201 })
  },
)
