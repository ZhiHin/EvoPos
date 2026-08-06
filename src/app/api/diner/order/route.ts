import { NextResponse } from 'next/server'

import { assertSameOrigin, readJson, withRoute } from '@/lib/api'
import { requireDiner } from '@/modules/session/diner'
import { placeDinerOrder } from '@/modules/session/order.service'
import { placeOrderSchema } from '@/modules/session/session.validation'

/**
 * Places an order for the current diner.
 *
 * The payload carries item ids, quantities and modifier choices — never
 * prices. Every amount is recomputed server-side from the menu and frozen
 * onto the line, so a tampered request buys nothing.
 */
export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const input = placeOrderSchema.parse(await readJson(request))

  const placed = await requireDiner((tx, diner) =>
    placeDinerOrder(tx, diner, input),
  )

  return NextResponse.json({ lines: placed }, { status: 201 })
})
