import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { readAdvisorReport } from '@/modules/advisor/advisor.service'
import {
  parseReportQuery,
  resolveReportRequest,
} from '@/modules/reporting/reporting.validation'

/**
 * The advisor's findings.
 *
 * `insight.view` rather than `report.financial`, even though the findings
 * carry money: the advisor reads across every domain at once, so seeing it
 * means seeing the financial picture whether or not any single figure is
 * labelled financial. It is its own permission for that reason.
 */
export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('insight.view')

  const resolved = await resolveReportRequest(
    ctx.tenant.restaurantId,
    ctx.user.id,
    parseReportQuery(request.url),
  )

  return NextResponse.json(
    await readAdvisorReport(
      resolved.ctx,
      resolved.filters.range,
      resolved.filters.branchId ?? null,
    ),
    // Recomputed on every read; a cached recommendation can outlive its fact.
    { headers: { 'cache-control': 'no-store' } },
  )
})
