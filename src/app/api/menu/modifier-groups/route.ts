import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { createModifierGroup } from '@/modules/modifier/modifier.service'
import { createModifierGroupSchema } from '@/modules/modifier/modifier.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('menu.modifier.create')
  const input = createModifierGroupSchema.parse(await readJson(request))

  const group = await createModifierGroup(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json(group, { status: 201 })
})
