import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { revokeApiKey } from '@/modules/integration/api-key.service'

interface RouteContext {
  params: Promise<{ keyId: string }>
}

/**
 * Revokes a key.
 *
 * DELETE on the resource, though the row is not deleted — it is marked
 * revoked. The row is what lets "what was pulling our menu in March?" be
 * answered at all, and removing it would take the audit trail's referent with
 * it.
 */
export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('integration.manage')
    const { keyId } = await params

    await revokeApiKey(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      keyId,
    )

    return NextResponse.json({ ok: true })
  },
)
