import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { createModifierOption } from '@/modules/modifier/modifier.service'
import { createModifierOptionSchema } from '@/modules/modifier/modifier.validation'

interface RouteContext {
  params: Promise<{ groupId: string }>
}

/**
 * Adding an option can make a required group satisfiable, or a delete can
 * make it impossible — the service re-checks coherence inside the same
 * transaction either way, so an incoherent group never reaches the database.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('menu.modifier.update')
    const { groupId } = await params
    const input = createModifierOptionSchema.parse(await readJson(request))

    const option = await createModifierOption(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      groupId,
      input,
    )

    return NextResponse.json(option, { status: 201 })
  },
)
