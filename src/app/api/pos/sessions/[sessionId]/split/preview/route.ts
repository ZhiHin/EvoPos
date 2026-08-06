import { NextResponse } from 'next/server'

import { assertSameOrigin, readJson, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { previewSplit } from '@/modules/bill/bill.service'
import { previewSplitSchema } from '@/modules/bill/bill.validation'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/**
 * Computes a split without saving it.
 *
 * POST rather than GET because the strategy — percentages, per-item
 * assignments — is a structured body, not something that belongs in a query
 * string. Nothing is persisted, so it is safe to call on every adjustment.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('bill.split')
    const { sessionId } = await params
    const input = previewSplitSchema.parse(await readJson(request))

    const result = await previewSplit(
      ctx.tenant.restaurantId,
      ctx.user.id,
      sessionId,
      input.strategy,
    )

    return NextResponse.json(result)
  },
)
