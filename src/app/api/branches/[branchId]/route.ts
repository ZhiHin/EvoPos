import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  deactivateBranch,
  updateBranch,
} from '@/modules/branch/branch.service'
import { updateBranchSchema } from '@/modules/branch/branch.validation'

interface RouteContext {
  params: Promise<{ branchId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('branch.update')
    const { branchId } = await params
    const input = updateBranchSchema.parse(await readJson(request))

    await updateBranch(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      branchId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

/**
 * Deactivates the branch. Modelled as DELETE because that is what the client
 * is expressing — "close this branch" — even though no row is removed.
 */
export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('branch.delete')
    const { branchId } = await params

    await deactivateBranch(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      branchId,
    )

    return NextResponse.json({ ok: true })
  },
)
