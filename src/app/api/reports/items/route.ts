import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { readItemReport } from '@/modules/reporting/report.service'
import {
  parseReportQuery,
  resolveReportRequest,
} from '@/modules/reporting/reporting.validation'

/**
 * Operational: what sells, in what quantity. Held by anyone who plans a menu
 * or a prep list, and it carries no restaurant-level financial figure.
 *
 * It does carry per-item revenue and, where a recipe exists, per-item cost.
 * That is a deliberate line: knowing a dish costs RM 4 to make is the whole
 * point of a menu engineering report, and it says nothing about the takings.
 */
export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('report.view')

  const resolved = await resolveReportRequest(
    ctx.tenant.restaurantId,
    ctx.user.id,
    parseReportQuery(request.url),
  )

  return NextResponse.json(
    await readItemReport(resolved.ctx, resolved.filters),
  )
})
