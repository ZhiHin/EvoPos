import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  dismissInsight,
  restoreInsight,
} from '@/modules/advisor/advisor.service'
import { dismissInsightSchema } from '@/modules/advisor/advisor.validation'

/**
 * Answering a recommendation.
 *
 * `insight.dismiss` is deliberately not held by the manager template. Reading
 * a finding and silencing one are different acts: "that recommendation is
 * wrong" and "I do not want that recommendation seen" look identical from the
 * outside, which is why the reason is required and the act is audited.
 */
export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('insight.dismiss')
  const input = dismissInsightSchema.parse(await readJson(request))

  await dismissInsight(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    {
      insightKey: input.insightKey,
      reason: input.reason,
      snoozeDays: input.snoozeDays,
    },
  )

  return NextResponse.json({ ok: true })
})

/** Un-hides a recommendation, so it is raised again on the next read. */
export const DELETE = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('insight.dismiss')
  const insightKey = new URL(request.url).searchParams.get('insightKey') ?? ''

  await restoreInsight(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    insightKey,
  )

  return NextResponse.json({ ok: true })
})
