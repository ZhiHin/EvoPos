import type { Metadata } from 'next'
import Link from 'next/link'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { requireAnyPermission } from '@/lib/auth/context'
import { cn } from '@/lib/utils'
import { listBranches } from '@/modules/branch/branch.service'
import { describeRange } from '@/modules/reporting/report'
import {
  readItemReport,
  readLossReport,
  readSalesReport,
  readTaxReport,
} from '@/modules/reporting/report.service'
import {
  reportQuerySchema,
  resolveReportRequest,
  type ReportKey,
} from '@/modules/reporting/reporting.validation'
import { ExportLinks } from '@/modules/reporting/ui/export-links'
import { ItemReportView } from '@/modules/reporting/ui/item-report-view'
import { LossReportView } from '@/modules/reporting/ui/loss-report-view'
import { ReportControls } from '@/modules/reporting/ui/report-controls'
import { SalesReportView } from '@/modules/reporting/ui/sales-report-view'
import { TaxReportView } from '@/modules/reporting/ui/tax-report-view'

export const metadata: Metadata = { title: 'Reports' }

const TABS: { key: ReportKey; label: string; financial: boolean }[] = [
  { key: 'sales', label: 'Sales', financial: true },
  { key: 'items', label: 'Items', financial: false },
  { key: 'tax', label: 'Tax', financial: true },
  { key: 'loss', label: 'Discounts & voids', financial: true },
]

/**
 * Reports.
 *
 * Every figure on this page comes from the snapshot written when each bill was
 * settled, never from recomputing old bills against current settings. That is
 * what makes a report filed in March still say the same thing in April.
 *
 * The whole page is bounded by the restaurant's own trading day, not the
 * server's midnight and not the browser's.
 */
export default async function ReportsPage({
  searchParams,
}: PageProps<'/reports'>) {
  const ctx = await requireAnyPermission(['report.view', 'report.financial'])
  const { restaurantId } = ctx.tenant

  const canSeeFinancial = ctx.tenant.permissions.has('report.financial')
  const canExport = ctx.tenant.permissions.has('report.export')

  const visibleTabs = TABS.filter((tab) => canSeeFinancial || !tab.financial)

  const params = await searchParams
  const single = (key: string): string | undefined =>
    typeof params[key] === 'string' ? params[key] : undefined

  const requested = single('report')
  const active =
    visibleTabs.find((tab) => tab.key === requested) ?? visibleTabs[0]

  const query = reportQuerySchema.parse({
    from: single('from'),
    to: single('to'),
    branchId: single('branchId'),
    granularity: single('granularity'),
  })

  const [resolved, branches] = await Promise.all([
    resolveReportRequest(restaurantId, ctx.user.id, query),
    listBranches(restaurantId, ctx.user.id),
  ])

  /** The querystring the export links and tab links carry forward. */
  const carried = new URLSearchParams()
  carried.set('from', resolved.fromIsoDate)
  carried.set('to', resolved.toIsoDate)
  if (query.branchId) carried.set('branchId', query.branchId)
  if (active.key === 'sales') carried.set('granularity', resolved.granularity)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            {describeRange(
              resolved.filters.range,
              resolved.timeZone,
              resolved.ctx.businessDayStartMinutes,
            )}{' '}
            · trading days in {resolved.timeZone}
          </p>
        </div>

        {canExport && (
          <ExportLinks report={active.key} query={carried.toString()} />
        )}
      </div>

      <nav className="flex flex-wrap gap-1 border-b print:hidden">
        {visibleTabs.map((tab) => {
          const tabQuery = new URLSearchParams(carried)
          tabQuery.set('report', tab.key)

          return (
            <Link
              key={tab.key}
              href={`/reports?${tabQuery.toString()}`}
              aria-current={tab.key === active.key ? 'page' : undefined}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
                tab.key === active.key
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>

      <ReportControls
        report={active.key}
        from={resolved.fromIsoDate}
        to={resolved.toIsoDate}
        branchId={query.branchId ?? null}
        granularity={resolved.granularity}
        branches={branches.map((branch) => ({
          id: branch.id,
          name: branch.name,
        }))}
        showGranularity={active.key === 'sales'}
      />

      {active.key === 'sales' && (
        <SalesReportView
          report={await readSalesReport(
            resolved.ctx,
            resolved.filters,
            resolved.granularity,
          )}
          currency={resolved.currency}
          timeZone={resolved.timeZone}
        />
      )}

      {active.key === 'items' && (
        <ItemReportView
          report={await readItemReport(resolved.ctx, resolved.filters)}
          currency={resolved.currency}
          canSeeCost={canSeeFinancial}
        />
      )}

      {active.key === 'tax' && (
        <TaxReportView
          report={await readTaxReport(resolved.ctx, resolved.filters)}
          currency={resolved.currency}
        />
      )}

      {active.key === 'loss' && (
        <LossReportView
          report={await readLossReport(resolved.ctx, resolved.filters)}
          currency={resolved.currency}
        />
      )}

      <Alert className="print:hidden">
        <AlertDescription>
          {/*
            The distinction that catches people out. Both views are correct
            answers to different questions, and a manager comparing them
            without knowing which is which concludes the system is broken.
          */}
          These figures are stated on a <strong>sales</strong> basis: a bill
          counts towards the day it was settled, and a refund reduces the
          period of the original sale. The takings page is on a{' '}
          <strong>cash</strong> basis and counts by when money moved, which is
          what you reconcile the drawer against.
        </AlertDescription>
      </Alert>
    </div>
  )
}
