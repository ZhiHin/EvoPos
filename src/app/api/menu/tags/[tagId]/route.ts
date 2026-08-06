import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { deleteTag, updateTag } from '@/modules/menu/tag.service'
import { updateTagSchema } from '@/modules/menu/menu.validation'

interface RouteContext {
  params: Promise<{ tagId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.tag.manage')
    const { tagId } = await params
    const input = updateTagSchema.parse(await readJson(request))

    await updateTag(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      tagId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.tag.manage')
    const { tagId } = await params

    await deleteTag(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      tagId,
    )

    return NextResponse.json({ ok: true })
  },
)
