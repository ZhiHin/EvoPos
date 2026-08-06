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
  createReservation,
  listReservations,
} from '@/modules/reservation/reservation.service'
import { createReservationSchema } from '@/modules/reservation/reservation.validation'

export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('reservation.view')

  const url = new URL(request.url)
  const branchId = url.searchParams.get('branchId')
  const date = url.searchParams.get('date')

  if (!branchId) {
    throw new ValidationError('A branch is required.', {
      branchId: ['A branch is required.'],
    })
  }

  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
  const from = day ? new Date(`${day}T00:00:00`) : new Date()
  const to = new Date(from)
  to.setDate(to.getDate() + 1)

  return NextResponse.json(
    await listReservations(
      ctx.tenant.restaurantId,
      ctx.user.id,
      branchId,
      from,
      to,
    ),
  )
})

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('reservation.create')
  const input = createReservationSchema.parse(await readJson(request))

  const created = await createReservation(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    {
      branchId: input.branchId,
      guestName: input.guestName,
      guestPhone: input.guestPhone ?? null,
      guestEmail: input.guestEmail ?? null,
      customerId: input.customerId ?? null,
      partySize: input.partySize,
      startsAt: new Date(input.startsAt),
      turnMinutes: input.turnMinutes,
      tableId: input.tableId ?? null,
      notes: input.notes ?? null,
      occasion: input.occasion ?? null,
    },
  )

  return NextResponse.json(created, { status: 201 })
})
