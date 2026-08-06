import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { voidOrderLine } from '@/modules/session/order.service'
import { voidLineSchema } from '@/modules/pos/pos.validation'

interface RouteContext {
  params: Promise<{ lineId: string }>
}

/**
 * POST rather than DELETE, because nothing is deleted: the line stays with
 * `status = 'voided'` so an owner reviewing suspicious removals can still see
 * what was ordered, by whom it was removed, and why.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('order.void')
    const { lineId } = await params
    const input = voidLineSchema.parse(await readJson(request))

    await voidOrderLine(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      lineId,
      input.reason,
    )

    return NextResponse.json({ ok: true })
  },
)
