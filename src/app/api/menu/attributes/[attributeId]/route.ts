import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { deleteAttributeDefinition } from '@/modules/menu/attribute.service'

interface RouteContext {
  params: Promise<{ attributeId: string }>
}

/**
 * No PATCH.
 *
 * Editing a definition in place would strand values already stored under the
 * old shape — changing a `select`'s options, or its type outright, can make
 * every existing item's value invalid with no way to tell which were affected.
 * Delete and re-create is the honest operation: values under the old key
 * survive untouched and become live again if the key is reused.
 */
export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.attribute.manage')
    const { attributeId } = await params

    await deleteAttributeDefinition(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      attributeId,
    )

    return NextResponse.json({ ok: true })
  },
)
