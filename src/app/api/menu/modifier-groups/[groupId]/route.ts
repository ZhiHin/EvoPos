import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  deleteModifierGroup,
  updateModifierGroup,
} from '@/modules/modifier/modifier.service'
import { updateModifierGroupSchema } from '@/modules/modifier/modifier.validation'

interface RouteContext {
  params: Promise<{ groupId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.modifier.update')
    const { groupId } = await params
    const input = updateModifierGroupSchema.parse(await readJson(request))

    await updateModifierGroup(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      groupId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.modifier.delete')
    const { groupId } = await params

    await deleteModifierGroup(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      groupId,
    )

    return NextResponse.json({ ok: true })
  },
)
