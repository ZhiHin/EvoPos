import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { receiveGoods } from '@/modules/inventory/purchasing.service'
import { receiveGoodsSchema } from '@/modules/inventory/inventory.validation'

interface RouteContext {
  params: Promise<{ purchaseOrderId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('purchase.receive')
    const { purchaseOrderId } = await params
    const input = receiveGoodsSchema.parse(await readJson(request))

    const result = await receiveGoods(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      purchaseOrderId,
      input.lines.map((line) => ({
        purchaseOrderLineId: line.purchaseOrderLineId,
        receivedMilli: line.received,
        unitCostMinor: line.unitCost,
      })),
    )

    return NextResponse.json(result, { status: 201 })
  },
)
