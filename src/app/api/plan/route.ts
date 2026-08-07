import { NextResponse } from 'next/server'
import { z } from 'zod'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  changePlan,
  readPlanStatus,
} from '@/modules/billing/billing.service'
import { PLAN_ORDER, type PlanKey } from '@/modules/billing/plans'

const changePlanSchema = z.object({
  plan: z.enum(PLAN_ORDER as unknown as [PlanKey, ...PlanKey[]]),
})

export const GET = withRoute(async () => {
  const ctx = await requirePermission('billing.view')

  return NextResponse.json(
    await readPlanStatus(ctx.tenant.restaurantId, ctx.user.id),
    { headers: { 'cache-control': 'no-store' } },
  )
})

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('billing.manage')
  const input = changePlanSchema.parse(await readJson(request))

  /**
   * Returns the effect rather than `{ ok: true }`. A downgrade that left the
   * account over quota should be visible in the response, not only in the
   * audit trail — the caller is the one who has to explain it afterwards.
   */
  return NextResponse.json(
    await changePlan(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      input.plan,
    ),
  )
})
