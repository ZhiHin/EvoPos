import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  rescheduleReservation,
  seatReservation,
} from '@/modules/reservation/reservation.service'
import { rescheduleReservationSchema } from '@/modules/reservation/reservation.validation'

interface RouteContext {
  params: Promise<{ reservationId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('reservation.update')
    const { reservationId } = await params
    const input = rescheduleReservationSchema.parse(await readJson(request))

    await rescheduleReservation(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      reservationId,
      {
        startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
        partySize: input.partySize,
        tableId: input.tableId,
      },
    )

    return NextResponse.json({ ok: true })
  },
)

/** Seating a booking opens the bill it becomes. */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('reservation.seat')
    const { reservationId } = await params

    return NextResponse.json(
      await seatReservation(
        {
          restaurantId: ctx.tenant.restaurantId,
          userId: ctx.user.id,
          ...getRequestMetadata(request),
        },
        reservationId,
      ),
      { status: 201 },
    )
  },
)

