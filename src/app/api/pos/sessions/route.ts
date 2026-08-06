import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { assertBranchAccess, requirePermission } from '@/lib/auth/context'
import { openTakeawaySession } from '@/modules/pos/pos.service'
import { openTakeawaySchema } from '@/modules/pos/pos.validation'

/** Opens a takeaway or delivery session — a bill with no table. */
export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('pos.takeaway')
  const input = openTakeawaySchema.parse(await readJson(request))

  assertBranchAccess(ctx, input.branchId)

  const session = await openTakeawaySession(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json(session, { status: 201 })
})
