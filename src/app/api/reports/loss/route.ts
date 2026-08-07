import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { readLossReport } from '@/modules/reporting/report.service'
import {
  parseReportQuery,
  resolveReportRequest,
} from '@/modules/reporting/reporting.validation'

/**
 * Financial, not operational. This report names the people who comped and
 * voided, and reads as an accusation in the wrong hands — which is exactly
 * why it exists, and exactly why it is not handed out with the menu reports.
 */
export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('report.financial')

  const resolved = await resolveReportRequest(
    ctx.tenant.restaurantId,
    ctx.user.id,
    parseReportQuery(request.url),
  )

  return NextResponse.json(await readLossReport(resolved.ctx, resolved.filters))
})
