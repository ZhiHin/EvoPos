import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { mergeSessions } from '@/modules/pos/pos.service'
import { mergeSessionsSchema } from '@/modules/pos/pos.validation'

interface RouteContext {
  params: Promise<{ sessionId: string }>
}

/** The session in the path is the survivor; the one in the body is absorbed. */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('pos.merge')
    const { sessionId } = await params
    const input = mergeSessionsSchema.parse(await readJson(request))

    const result = await mergeSessions(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      sessionId,
      input,
    )

    return NextResponse.json(result)
  },
)
