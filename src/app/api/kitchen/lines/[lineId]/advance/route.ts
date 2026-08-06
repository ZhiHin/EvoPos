import { NextResponse } from 'next/server'
import { z } from 'zod'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { advanceOrderLine } from '@/modules/kitchen/kitchen.service'

const advanceSchema = z.object({
  to: z.enum(['preparing', 'ready', 'served']),
})

interface RouteContext {
  params: Promise<{ lineId: string }>
}

/**
 * Moves a ticket line forward.
 *
 * Forward only — the service refuses to go back. Un-serving a line would make
 * its timestamps meaningless, and those timestamps are what any later
 * question about kitchen speed rests on.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('kitchen.advance')
    const { lineId } = await params
    const input = advanceSchema.parse(await readJson(request))

    await advanceOrderLine(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      lineId,
      input.to,
    )

    return NextResponse.json({ ok: true })
  },
)
