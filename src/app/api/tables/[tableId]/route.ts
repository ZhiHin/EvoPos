import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { deleteTable, updateTable } from '@/modules/table/table.service'
import { updateTableSchema } from '@/modules/table/table.validation'

interface RouteContext {
  params: Promise<{ tableId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('table.update')
    const { tableId } = await params
    const input = updateTableSchema.parse(await readJson(request))

    await updateTable(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      tableId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('table.delete')
    const { tableId } = await params

    await deleteTable(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      tableId,
    )

    return NextResponse.json({ ok: true })
  },
)
