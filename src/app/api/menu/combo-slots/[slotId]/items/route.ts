import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { addComboGroupItem } from '@/modules/modifier/combo.service'
import { createComboGroupItemSchema } from '@/modules/modifier/modifier.validation'

interface RouteContext {
  params: Promise<{ slotId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.combo.update')
    const { slotId } = await params
    const input = createComboGroupItemSchema.parse(await readJson(request))

    const item = await addComboGroupItem(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      slotId,
      input,
    )

    return NextResponse.json(item, { status: 201 })
  },
)
