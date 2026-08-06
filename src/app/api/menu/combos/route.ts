import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { createCombo } from '@/modules/modifier/combo.service'
import { createComboSchema } from '@/modules/modifier/modifier.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('menu.combo.create')
  const input = createComboSchema.parse(await readJson(request))

  const combo = await createCombo(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json(combo, { status: 201 })
})
