import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { voidSplit } from '@/modules/bill/bill.service'
import { voidSplitSchema } from '@/modules/bill/bill.validation'

interface RouteContext {
  params: Promise<{ splitId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('bill.void')
    const { splitId } = await params
    const input = voidSplitSchema.parse(await readJson(request))

    await voidSplit(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      splitId,
      input.reason,
    )

    return NextResponse.json({ ok: true })
  },
)
