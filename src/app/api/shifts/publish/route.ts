import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { publishRoster } from '@/modules/workforce/workforce.service'
import { publishRosterSchema } from '@/modules/workforce/workforce.validation'

/**
 * Publishes a week.
 *
 * Returns conflicts rather than throwing them, because a roster that puts
 * someone in two places at once needs a manager to look at names, not an
 * error banner.
 */
export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('shift.publish')
  const input = publishRosterSchema.parse(await readJson(request))

  const result = await publishRoster(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input.branchId,
    new Date(input.from),
    new Date(input.to),
  )

  return NextResponse.json(result)
})
