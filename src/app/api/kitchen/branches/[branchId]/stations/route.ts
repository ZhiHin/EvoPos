import { NextResponse } from 'next/server'
import { z } from 'zod'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { assertBranchAccess, requirePermission } from '@/lib/auth/context'
import { createStation } from '@/modules/kitchen/kitchen.service'

const createStationSchema = z.object({
  name: z.string().trim().min(1, 'Station name is required').max(80),
  kind: z.enum(['food', 'beverage', 'dessert', 'other']).default('food'),
  displayOrder: z.number().int().min(0).max(999).default(0),
  isDefault: z.boolean().default(false),
})

interface RouteContext {
  params: Promise<{ branchId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('kitchen.station.manage')
    const { branchId } = await params
    assertBranchAccess(ctx, branchId)

    const input = createStationSchema.parse(await readJson(request))

    const station = await createStation(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      branchId,
      input,
    )

    return NextResponse.json(station, { status: 201 })
  },
)
