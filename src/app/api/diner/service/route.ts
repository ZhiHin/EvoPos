import { NextResponse } from 'next/server'

import { assertSameOrigin, readJson, withRoute } from '@/lib/api'
import { requireDiner } from '@/modules/session/diner'
import { raiseServiceRequest } from '@/modules/session/order.service'
import { serviceRequestSchema } from '@/modules/session/session.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const input = serviceRequestSchema.parse(await readJson(request))

  const result = await requireDiner((tx, diner) =>
    raiseServiceRequest(tx, diner, input),
  )

  return NextResponse.json(result, { status: 201 })
})
