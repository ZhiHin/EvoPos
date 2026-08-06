import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  attachModifierGroupToItem,
  detachModifierGroupFromItem,
} from '@/modules/modifier/modifier.service'
import { attachModifierGroupSchema } from '@/modules/modifier/modifier.validation'

interface RouteContext {
  params: Promise<{ itemId: string }>
}

/** Upserts, so re-posting an attachment updates its overrides. */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.item.update')
    const { itemId } = await params
    const input = attachModifierGroupSchema.parse(await readJson(request))

    await attachModifierGroupToItem(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      itemId,
      input,
    )

    return NextResponse.json({ ok: true }, { status: 201 })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.item.update')
    const { itemId } = await params
    const { modifierGroupId } = (await readJson(request)) as {
      modifierGroupId: string
    }

    await detachModifierGroupFromItem(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      itemId,
      modifierGroupId,
    )

    return NextResponse.json({ ok: true })
  },
)
