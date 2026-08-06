import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  seatFromWaitlist,
  updateWaitlistStatus,
} from '@/modules/reservation/reservation.service'
import { waitlistActionSchema } from '@/modules/reservation/reservation.validation'

interface RouteContext {
  params: Promise<{ entryId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('waitlist.manage')
    const { entryId } = await params
    const input = waitlistActionSchema.parse(await readJson(request))

    const actor = {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    }

    if (input.action === 'seat') {
      return NextResponse.json(
        await seatFromWaitlist(actor, entryId, input.tableId),
        { status: 201 },
      )
    }

    await updateWaitlistStatus(
      actor,
      entryId,
      input.action === 'notify' ? 'notified' : 'left',
    )

    return NextResponse.json({ ok: true })
  },
)
