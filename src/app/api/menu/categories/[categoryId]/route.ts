import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  deleteCategory,
  updateCategory,
} from '@/modules/menu/category.service'
import { updateCategorySchema } from '@/modules/menu/menu.validation'

interface RouteContext {
  params: Promise<{ categoryId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.category.update')
    const { categoryId } = await params
    const input = updateCategorySchema.parse(await readJson(request))

    await updateCategory(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      categoryId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.category.delete')
    const { categoryId } = await params

    await deleteCategory(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      categoryId,
    )

    return NextResponse.json({ ok: true })
  },
)
