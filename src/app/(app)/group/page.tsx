import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { requirePermission } from '@/lib/auth/context'
import { formatMoney } from '@/lib/money'
import { planHasFeature } from '@/modules/billing/billing.service'
import { readGroupComparison } from '@/modules/billing/group.service'
import { MIN_BRANCHES_TO_COMPARE } from '@/modules/billing/group'
import { describeRange } from '@/modules/reporting/report'
import {
  reportQuerySchema,
  resolveReportRequest,
} from '@/modules/reporting/reporting.validation'
import { ReportControls } from '@/modules/reporting/ui/report-controls'
import { formatPercent, Stat } from '@/modules/reporting/ui/stat'

export const metadata: Metadata = { title: 'Group' }

/**
 * Sites compared to each other.
 *
 * Ranked by takings, because that is what an owner looks for first — but the
 * part that earns the page is the exceptions list, which finds the site
 * underperforming *for its size*. A league table alone tells a group owner
 * what they already know.
 */
export default async function GroupPage({
  searchParams,
}: PageProps<'/group'>) {
  const ctx = await requirePermission('report.financial')
  const { restaurantId } = ctx.tenant

  if (
    !(await planHasFeature(
      { restaurantId, userId: ctx.user.id },
      'groupDashboard',
    ))
  ) {
    redirect('/plan')
  }

  const params = await searchParams
  const single = (key: string): string | undefined =>
    typeof params[key] === 'string' ? params[key] : undefined

  const resolved = await resolveReportRequest(
    restaurantId,
    ctx.user.id,
    reportQuerySchema.parse({ from: single('from'), to: single('to') }),
  )

  const comparison = await readGroupComparison(
    resolved.ctx,
    resolved.filters.range,
  )

  const money = (minor: number): string =>
    formatMoney(minor, resolved.currency)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Group</h1>
        <p className="text-sm text-muted-foreground">
          {describeRange(
            resolved.filters.range,
            resolved.timeZone,
            resolved.ctx.businessDayStartMinutes,
          )}{' '}
          · every site, including any that took nothing
        </p>
      </div>

      <ReportControls
        report="group"
        from={resolved.fromIsoDate}
        to={resolved.toIsoDate}
        branchId={null}
        granularity={resolved.granularity}
        branches={[]}
        showGranularity={false}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sites" value={String(comparison.totals.branches)} />
        <Stat
          label="Net sales"
          value={money(comparison.totals.netSalesMinor)}
        />
        <Stat
          label="Gross profit"
          value={money(comparison.totals.grossProfitMinor)}
        />
        <Stat
          label="Median bill"
          value={
            comparison.median.averageBillMinor === null
              ? '—'
              : money(comparison.median.averageBillMinor)
          }
          hint="What the exceptions below are measured against"
        />
      </div>

      {comparison.outliers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Worth asking about</CardTitle>
            <CardDescription>
              Sites more than 20% from the group median. Both directions — a
              site doing something that works is as worth finding as one that
              is not.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y text-sm">
              {comparison.outliers.map((outlier) => (
                <li key={`${outlier.branchId}:${outlier.kind}`} className="px-6 py-3">
                  {outlier.message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {comparison.outliers.length === 0 &&
        comparison.totals.branches < MIN_BRANCHES_TO_COMPARE && (
          <Alert>
            <AlertDescription>
              {/*
                Two sites do not have a median; they have each other. Calling
                the smaller an outlier because it differs from the larger is
                arithmetic dressed up as insight.
              */}
              Comparison needs at least {MIN_BRANCHES_TO_COMPARE} trading sites.
              Below that there is no middle to measure against, and any
              difference is just the two of them being different.
            </AlertDescription>
          </Alert>
        )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By site</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Site</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead className="text-right">Bills</TableHead>
                <TableHead className="text-right">Covers</TableHead>
                <TableHead className="text-right">Net sales</TableHead>
                <TableHead className="text-right">Average bill</TableHead>
                <TableHead className="text-right">Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {comparison.branches.map((branch) => (
                <TableRow key={branch.branchId}>
                  <TableCell className="font-medium">
                    {branch.name}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {branch.code}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {(branch.shareBasisPoints / 100).toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {branch.bills}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {branch.covers}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {money(branch.netSalesMinor)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {branch.bills === 0 ? '—' : money(branch.averageBillMinor)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatPercent(branch.marginBasisPoints)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
