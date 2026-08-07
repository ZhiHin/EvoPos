import { NextResponse } from 'next/server'
import { z } from 'zod'

import { assertSameOrigin, readJson, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { previewPlanChange } from '@/modules/billing/billing.service'
import { PLAN_ORDER, type PlanKey } from '@/modules/billing/plans'

const previewSchema = z.object({
  plan: z.enum(PLAN_ORDER as unknown as [PlanKey, ...PlanKey[]]),
})

/**
 * What a plan change would mean, without making it.
 *
 * A POST despite changing nothing, because the body carries the target plan
 * and a GET with it in the query string would end up in access logs and
 * browser history for no reason.
 *
 * Behind `billing.view`, not `billing.manage`: seeing the consequences of a
 * change is how somebody decides whether to ask for one.
 */
export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('billing.view')
  const input = previewSchema.parse(await readJson(request))

  return NextResponse.json(
    await previewPlanChange(
      ctx.tenant.restaurantId,
      ctx.user.id,
      input.plan,
    ),
  )
})
