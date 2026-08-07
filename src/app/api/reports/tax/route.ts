import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { readTaxReport } from '@/modules/reporting/report.service'
import {
  parseReportQuery,
  resolveReportRequest,
} from '@/modules/reporting/reporting.validation'

export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('report.financial')

  const resolved = await resolveReportRequest(
    ctx.tenant.restaurantId,
    ctx.user.id,
    parseReportQuery(request.url),
  )

  return NextResponse.json(await readTaxReport(resolved.ctx, resolved.filters))
})
