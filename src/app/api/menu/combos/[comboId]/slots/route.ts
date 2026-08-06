import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { createComboGroup } from '@/modules/modifier/combo.service'
import { createComboGroupSchema } from '@/modules/modifier/modifier.validation'

interface RouteContext {
  params: Promise<{ comboId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.combo.update')
    const { comboId } = await params
    const input = createComboGroupSchema.parse(await readJson(request))

    const slot = await createComboGroup(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      comboId,
      input,
    )

    return NextResponse.json(slot, { status: 201 })
  },
)
