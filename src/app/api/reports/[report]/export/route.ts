import { requirePermission } from '@/lib/auth/context'
import { withRoute } from '@/lib/api'
import { ValidationError } from '@/lib/errors'
import { safeFilename, toCsv } from '@/modules/reporting/csv'
import {
  readItemReport,
  readLossReport,
  readSalesReport,
  readTaxReport,
} from '@/modules/reporting/report.service'
import {
  EXPORT_FORMATS,
  parseReportQuery,
  REPORT_KEYS,
  resolveReportRequest,
  type ExportFormat,
  type ReportKey,
} from '@/modules/reporting/reporting.validation'
import {
  exportBaseName,
  itemSheets,
  lossSheets,
  salesSheets,
  taxSheets,
} from '@/modules/reporting/sheets'
import type { Sheet } from '@/modules/reporting/sheet'
import { toXlsx, XLSX_CONTENT_TYPE } from '@/modules/reporting/xlsx'

/**
 * Downloading a report.
 *
 * `report.export` is required on top of whatever the report itself needs.
 * Downloading is not reading: a report on screen is bounded by the session,
 * and a spreadsheet leaves with whoever downloaded it and outlives their
 * employment. Both permissions are checked, so nobody can export a report
 * they would not be allowed to open.
 */

/** Operational reports need `report.view`; money reports need `report.financial`. */
const PERMISSION: Record<ReportKey, string> = {
  sales: 'report.financial',
  items: 'report.view',
  tax: 'report.financial',
  loss: 'report.financial',
}

function isReportKey(value: string): value is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(value)
}

function isFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value)
}

export const GET = withRoute(
  async (request: Request, context: RouteContext<'/api/reports/[report]/export'>) => {
    const { report } = await context.params

    if (!isReportKey(report)) {
      throw new ValidationError('There is no such report.', {
        report: [`Choose one of: ${REPORT_KEYS.join(', ')}.`],
      })
    }

    const ctx = await requirePermission(PERMISSION[report])
    await requirePermission('report.export')

    const url = new URL(request.url)
    const format = url.searchParams.get('format') ?? 'csv'
    if (!isFormat(format)) {
      throw new ValidationError('That file format is not supported.', {
        format: [`Choose one of: ${EXPORT_FORMATS.join(', ')}.`],
      })
    }

    const resolved = await resolveReportRequest(
      ctx.tenant.restaurantId,
      ctx.user.id,
      parseReportQuery(request.url),
    )

    const sheets = await buildSheets(report, resolved)

    const base = exportBaseName(
      report,
      resolved.filters.range,
      resolved.timeZone,
      resolved.ctx.businessDayStartMinutes,
    )

    if (format === 'xlsx') {
      const bytes = toXlsx(sheets)
      return new Response(bytes as BodyInit, {
        headers: {
          'content-type': XLSX_CONTENT_TYPE,
          'content-disposition': `attachment; filename="${safeFilename(base, 'xlsx')}"`,
          /**
           * A report is a point-in-time answer about money. Caching one and
           * serving it to the next person who asks is how two managers end up
           * arguing over figures that were never for the same period.
           */
          'cache-control': 'no-store',
        },
      })
    }

    /**
     * CSV carries one table, so a multi-sheet report exports its first — the
     * one the report is named for. Anyone wanting the rest wants the workbook,
     * and silently concatenating incompatible tables into one file would
     * produce something no spreadsheet can open sensibly.
     */
    return new Response(toCsv(sheets[0]), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${safeFilename(base, 'csv')}"`,
        'cache-control': 'no-store',
      },
    })
  },
)

async function buildSheets(
  report: ReportKey,
  resolved: Awaited<ReturnType<typeof resolveReportRequest>>,
): Promise<Sheet[]> {
  switch (report) {
    case 'sales':
      return salesSheets(
        await readSalesReport(
          resolved.ctx,
          resolved.filters,
          resolved.granularity,
        ),
        resolved.timeZone,
      )
    case 'items':
      return itemSheets(await readItemReport(resolved.ctx, resolved.filters))
    case 'tax':
      return taxSheets(await readTaxReport(resolved.ctx, resolved.filters))
    case 'loss':
      return lossSheets(await readLossReport(resolved.ctx, resolved.filters))
  }
}
