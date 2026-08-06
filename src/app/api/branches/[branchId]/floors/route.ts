import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { assertBranchAccess, requirePermission } from '@/lib/auth/context'
import { createFloor } from '@/modules/floor/floor.service'
import { createFloorSchema } from '@/modules/floor/floor.validation'

interface RouteContext {
  params: Promise<{ branchId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('floor.create')
    const { branchId } = await params

    /**
     * Branch scoping is not expressible as an RLS policy — it depends on the
     * member's assignment, not on a column of the row being written. Enforced
     * here instead, and it must not be forgotten on any branch-scoped route.
     */
    assertBranchAccess(ctx, branchId)

    const input = createFloorSchema.parse(await readJson(request))

    const floor = await createFloor(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      branchId,
      input,
    )

    return NextResponse.json(floor, { status: 201 })
  },
)
