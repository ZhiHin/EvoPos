import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  createSupplier,
  listSuppliers,
} from '@/modules/inventory/purchasing.service'
import { createSupplierSchema } from '@/modules/inventory/inventory.validation'

export const GET = withRoute(async () => {
  const ctx = await requirePermission('supplier.view')

  return NextResponse.json(
    await listSuppliers(ctx.tenant.restaurantId, ctx.user.id),
  )
})

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('supplier.manage')
  const input = createSupplierSchema.parse(await readJson(request))

  const created = await createSupplier(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json(created, { status: 201 })
})
