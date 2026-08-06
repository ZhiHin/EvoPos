import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { closeSession } from '@/modules/session/session.service'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/**
 * Closes a session and frees its table.
 *
 * Phase 5 closes without taking payment — payment lands in Phase 7, and
 * pretending to record one here would put an unbacked "paid" flag in the
 * ledger. What this does honestly is end the session and expire its diner
 * tokens.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('session.close')
    const { sessionId } = await params

    await closeSession(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      sessionId,
    )

    return NextResponse.json({ ok: true })
  },
)
