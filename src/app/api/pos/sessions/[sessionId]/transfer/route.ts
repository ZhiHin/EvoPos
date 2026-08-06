import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { transferSession } from '@/modules/pos/pos.service'
import { transferSessionSchema } from '@/modules/pos/pos.validation'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('pos.transfer')
    const { sessionId } = await params
    const input = transferSessionSchema.parse(await readJson(request))

    await transferSession(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      sessionId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)
