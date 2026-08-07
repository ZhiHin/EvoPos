import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { readLiveOperations } from '@/modules/reporting/operations.service'
import { getSettings } from '@/modules/settings/settings.service'

/**
 * The live operations readout.
 *
 * `report.view` rather than `report.financial`: this is what is happening in
 * the building — tables, queue, covers, staff on shift. The one money figure
 * it carries is today's own trade, which anyone running the floor can already
 * see accumulating on the till.
 */
export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('report.view')
  const branchId = new URL(request.url).searchParams.get('branchId')

  const settings = await getSettings(ctx.tenant.restaurantId, ctx.user.id)

  const operations = await readLiveOperations(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      timeZone: settings.timezone,
      businessDayStartMinutes: settings.businessDayStartMinutes,
    },
    new Date(),
    branchId,
  )

  return NextResponse.json(operations, {
    // Live means live. A cached dashboard is worse than no dashboard.
    headers: { 'cache-control': 'no-store' },
  })
})
