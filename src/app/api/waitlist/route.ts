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
  joinWaitlist,
  listWaitlist,
} from '@/modules/reservation/reservation.service'
import { joinWaitlistSchema } from '@/modules/reservation/reservation.validation'

export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('waitlist.view')
  const branchId = new URL(request.url).searchParams.get('branchId')

  if (!branchId) {
    throw new ValidationError('A branch is required.', {
      branchId: ['A branch is required.'],
    })
  }

  return NextResponse.json(
    await listWaitlist(ctx.tenant.restaurantId, ctx.user.id, branchId),
  )
})

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('waitlist.manage')
  const input = joinWaitlistSchema.parse(await readJson(request))

  const created = await joinWaitlist(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    {
      branchId: input.branchId,
      guestName: input.guestName,
      guestPhone: input.guestPhone ?? null,
      partySize: input.partySize,
      customerId: input.customerId ?? null,
      notes: input.notes ?? null,
    },
  )

  return NextResponse.json(created, { status: 201 })
})
