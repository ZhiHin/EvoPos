import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { createCategory } from '@/modules/menu/category.service'
import { createCategorySchema } from '@/modules/menu/menu.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('menu.category.create')
  const input = createCategorySchema.parse(await readJson(request))

  const category = await createCategory(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json(category, { status: 201 })
})
