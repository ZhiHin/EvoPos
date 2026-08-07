import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { readSalesReport } from '@/modules/reporting/report.service'
import {
  parseReportQuery,
  resolveReportRequest,
} from '@/modules/reporting/reporting.validation'

/**
 * Sales figures are money, so this needs `report.financial` rather than the
 * operational `report.view`. A head chef reading item performance should not
 * thereby learn what the business turns over.
 */
export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('report.financial')

  const resolved = await resolveReportRequest(
    ctx.tenant.restaurantId,
    ctx.user.id,
    parseReportQuery(request.url),
  )

  return NextResponse.json(
    await readSalesReport(resolved.ctx, resolved.filters, resolved.granularity),
  )
})
