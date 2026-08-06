import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { deleteCombo, updateCombo } from '@/modules/modifier/combo.service'
import { updateComboSchema } from '@/modules/modifier/modifier.validation'

interface RouteContext {
  params: Promise<{ comboId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.combo.update')
    const { comboId } = await params
    const input = updateComboSchema.parse(await readJson(request))

    await updateCombo(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      comboId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.combo.delete')
    const { comboId } = await params

    await deleteCombo(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      comboId,
    )

    return NextResponse.json({ ok: true })
  },
)
