import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { createBranch } from '@/modules/branch/branch.service'
import { createBranchSchema } from '@/modules/branch/branch.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('branch.create')
  const input = createBranchSchema.parse(await readJson(request))

  const branch = await createBranch(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json(branch, { status: 201 })
})
