import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { cancelReservation } from '@/modules/reservation/reservation.service'
import { cancelReservationSchema } from '@/modules/reservation/reservation.validation'

interface RouteContext {
  params: Promise<{ reservationId: string }>
}

/**
 * Cancels a booking, or marks it a no-show.
 *
 * Its own route rather than a DELETE on the booking, for two reasons: the
 * outcome is a body and DELETE bodies are poorly supported end to end, and
 * cancelling needs `reservation.cancel` while rescheduling needs
 * `reservation.update` — two permissions on one method would have to branch
 * inside the handler.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('reservation.cancel')
    const { reservationId } = await params
    const input = cancelReservationSchema.parse(await readJson(request))

    await cancelReservation(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      reservationId,
      input.outcome,
      input.reason,
    )

    return NextResponse.json({ ok: true })
  },
)
