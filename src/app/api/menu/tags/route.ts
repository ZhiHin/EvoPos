import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { createTag } from '@/modules/menu/tag.service'
import { createTagSchema } from '@/modules/menu/menu.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('menu.tag.manage')
  const input = createTagSchema.parse(await readJson(request))

  const tag = await createTag(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json(tag, { status: 201 })
})
