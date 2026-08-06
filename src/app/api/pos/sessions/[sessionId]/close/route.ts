import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { settleAndCloseSession } from '@/modules/payment/payment.service'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/**
 * Closes a session and frees its table.
 *
 * Refuses while anything is still outstanding. An unpaid bill quietly
 * disappearing is how money goes missing without anyone noticing — the table
 * is free, the screen is clear, and nobody can say what happened to the
 * forty ringgit.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('session.close')
    const { sessionId } = await params

    await settleAndCloseSession(
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
