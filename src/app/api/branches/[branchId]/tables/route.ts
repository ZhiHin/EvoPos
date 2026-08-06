import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { assertBranchAccess, requirePermission } from '@/lib/auth/context'
import { createTable } from '@/modules/table/table.service'
import { createTableSchema } from '@/modules/table/table.validation'

interface RouteContext {
  params: Promise<{ branchId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('table.create')
    const { branchId } = await params
    assertBranchAccess(ctx, branchId)

    const input = createTableSchema.parse(await readJson(request))

    const table = await createTable(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      branchId,
      input,
    )

    return NextResponse.json(table, { status: 201 })
  },
)
