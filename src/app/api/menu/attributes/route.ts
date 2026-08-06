import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { createAttributeDefinition } from '@/modules/menu/attribute.service'
import { createAttributeSchema } from '@/modules/menu/menu.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('menu.attribute.manage')
  const input = createAttributeSchema.parse(await readJson(request))

  const attribute = await createAttributeDefinition(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json(attribute, { status: 201 })
})
