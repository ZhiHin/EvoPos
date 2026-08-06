import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { deleteItem, updateItem } from '@/modules/menu/item.service'
import { updateItemSchema } from '@/modules/menu/menu.validation'

interface RouteContext {
  params: Promise<{ itemId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.item.update')
    const { itemId } = await params
    const input = updateItemSchema.parse(await readJson(request))

    await updateItem(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      itemId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.item.delete')
    const { itemId } = await params

    await deleteItem(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      itemId,
    )

    return NextResponse.json({ ok: true })
  },
)
