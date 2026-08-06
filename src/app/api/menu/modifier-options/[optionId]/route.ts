import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  deleteModifierOption,
  updateModifierOption,
} from '@/modules/modifier/modifier.service'
import { updateModifierOptionSchema } from '@/modules/modifier/modifier.validation'

interface RouteContext {
  params: Promise<{ optionId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.modifier.update')
    const { optionId } = await params
    const input = updateModifierOptionSchema.parse(await readJson(request))

    await updateModifierOption(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      optionId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.modifier.update')
    const { optionId } = await params

    await deleteModifierOption(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      optionId,
    )

    return NextResponse.json({ ok: true })
  },
)
