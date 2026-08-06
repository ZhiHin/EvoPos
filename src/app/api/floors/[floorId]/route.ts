import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { deleteFloor, updateFloor } from '@/modules/floor/floor.service'
import { updateFloorSchema } from '@/modules/floor/floor.validation'

interface RouteContext {
  params: Promise<{ floorId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('floor.update')
    const { floorId } = await params
    const input = updateFloorSchema.parse(await readJson(request))

    await updateFloor(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      floorId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('floor.delete')
    const { floorId } = await params

    await deleteFloor(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      floorId,
    )

    return NextResponse.json({ ok: true })
  },
)
