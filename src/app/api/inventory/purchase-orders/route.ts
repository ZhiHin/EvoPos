import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  createPurchaseOrder,
  listPurchaseOrders,
} from '@/modules/inventory/purchasing.service'
import { createPurchaseOrderSchema } from '@/modules/inventory/inventory.validation'

export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('purchase.view')
  const branchId = new URL(request.url).searchParams.get('branchId')

  return NextResponse.json(
    await listPurchaseOrders(
      ctx.tenant.restaurantId,
      ctx.user.id,
      branchId ?? undefined,
    ),
  )
})

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('purchase.create')
  const input = createPurchaseOrderSchema.parse(await readJson(request))

  const created = await createPurchaseOrder(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    {
      branchId: input.branchId,
      supplierId: input.supplierId,
      expectedAt: input.expectedAt ? new Date(input.expectedAt) : null,
      notes: input.notes ?? null,
      lines: input.lines.map((line) => ({
        ingredientId: line.ingredientId,
        orderedMilli: line.quantity,
        unitCostMinor: line.unitCost,
      })),
    },
  )

  return NextResponse.json(created, { status: 201 })
})
