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
  clockIn,
  clockOut,
  readTimesheet,
} from '@/modules/workforce/workforce.service'
import { clockActionSchema } from '@/modules/workforce/workforce.validation'

export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('attendance.view')

  const url = new URL(request.url)
  const branchId = url.searchParams.get('branchId')
  const week = url.searchParams.get('week')

  if (!branchId) {
    throw new ValidationError('A branch is required.', {
      branchId: ['A branch is required.'],
    })
  }

  const from =
    week && /^\d{4}-\d{2}-\d{2}$/.test(week)
      ? new Date(`${week}T00:00:00`)
      : new Date()
  const to = new Date(from)
  to.setDate(to.getDate() + 7)

  return NextResponse.json(
    await readTimesheet(
      ctx.tenant.restaurantId,
      ctx.user.id,
      branchId,
      from,
      to,
    ),
  )
})

/**
 * Clocks the acting user in or out.
 *
 * There is no user id in the body, and there never will be. Clocking in for a
 * colleague who is running late is buddy-punching, and the way to stop it is
 * to make it unexpressible rather than to guard it with a permission.
 */
export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('attendance.clock')
  const input = clockActionSchema.parse(await readJson(request))

  const actor = {
    restaurantId: ctx.tenant.restaurantId,
    userId: ctx.user.id,
    ...getRequestMetadata(request),
  }

  if (input.action === 'in') {
    return NextResponse.json(await clockIn(actor, input.branchId), {
      status: 201,
    })
  }

  return NextResponse.json(await clockOut(actor, input.breakMinutes))
})
