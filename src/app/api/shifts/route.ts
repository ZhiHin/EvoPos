import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { ValidationError } from '@/lib/errors'
import {
  createShift,
  listMyShifts,
  listShifts,
} from '@/modules/workforce/workforce.service'
import { createShiftSchema } from '@/modules/workforce/workforce.validation'

export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('shift.view')

  const url = new URL(request.url)
  const branchId = url.searchParams.get('branchId')
  const week = url.searchParams.get('week')
  const mine = url.searchParams.get('mine') === '1'

  const from =
    week && /^\d{4}-\d{2}-\d{2}$/.test(week)
      ? new Date(`${week}T00:00:00`)
      : new Date()
  const to = new Date(from)
  to.setDate(to.getDate() + 7)

  /**
   * Two reads rather than one filtered read. A shared query with a forgotten
   * `publishedAt` check would leak next week's draft roster to everybody in
   * it, and that mistake is invisible until someone is told a shift changed.
   */
  if (mine) {
    return NextResponse.json(
      await listMyShifts(ctx.tenant.restaurantId, ctx.user.id, from, to),
    )
  }

  if (!branchId) {
    throw new ValidationError('A branch is required.', {
      branchId: ['A branch is required.'],
    })
  }

  return NextResponse.json(
    await listShifts(ctx.tenant.restaurantId, ctx.user.id, branchId, from, to),
  )
})

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('shift.manage')
  const input = createShiftSchema.parse(await readJson(request))

  const created = await createShift(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    {
      branchId: input.branchId,
      userId: input.userId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      position: input.position ?? null,
      notes: input.notes ?? null,
    },
  )

  return NextResponse.json(created, { status: 201 })
})
