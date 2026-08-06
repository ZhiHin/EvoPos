import { NextResponse } from 'next/server'

import { assertSameOrigin, readJson, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { checkAvailability } from '@/modules/reservation/reservation.service'
import { availabilitySchema } from '@/modules/reservation/reservation.validation'

/**
 * Asks whether a slot could be booked, without booking it.
 *
 * The answer is advisory. `createReservation` re-checks inside its own
 * transaction, because two people on two phones can both be told yes a moment
 * before one of them takes the last table.
 */
export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('reservation.view')
  const input = availabilitySchema.parse(await readJson(request))

  return NextResponse.json(
    await checkAvailability(
      ctx.tenant.restaurantId,
      ctx.user.id,
      input.branchId,
      new Date(input.startsAt),
      input.partySize,
      input.turnMinutes,
      input.ignoreReservationId,
    ),
  )
})
