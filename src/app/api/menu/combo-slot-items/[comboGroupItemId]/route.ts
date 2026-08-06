import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { removeComboGroupItem } from '@/modules/modifier/combo.service'

interface RouteContext {
  params: Promise<{ comboGroupItemId: string }>
}

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.combo.update')
    const { comboGroupItemId } = await params

    await removeComboGroupItem(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      comboGroupItemId,
    )

    return NextResponse.json({ ok: true })
  },
)
