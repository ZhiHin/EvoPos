import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  createIngredient,
  listIngredients,
} from '@/modules/inventory/inventory.service'
import { createIngredientSchema } from '@/modules/inventory/inventory.validation'

export const GET = withRoute(async () => {
  const ctx = await requirePermission('ingredient.view')

  return NextResponse.json(
    await listIngredients(ctx.tenant.restaurantId, ctx.user.id),
  )
})

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('ingredient.manage')
  const input = createIngredientSchema.parse(await readJson(request))

  const created = await createIngredient(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    {
      name: input.name,
      category: input.category ?? null,
      unit: input.unit,
      costPerUnitMinor: input.costPerUnit,
      reorderPointMilli: input.reorderPoint,
      reorderQuantityMilli: input.reorderQuantity,
      preferredSupplierId: input.preferredSupplierId ?? null,
    },
  )

  return NextResponse.json(created, { status: 201 })
})
