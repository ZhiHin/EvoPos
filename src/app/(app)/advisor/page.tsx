import type { Metadata } from 'next'
import { Sparkles } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { requirePermission } from '@/lib/auth/context'
import { listBranches } from '@/modules/branch/branch.service'
import { readAdvisorReport } from '@/modules/advisor/advisor.service'
import { InsightCard } from '@/modules/advisor/ui/insight-card'
import { describeRange } from '@/modules/reporting/report'
import {
  reportQuerySchema,
  resolveReportRequest,
} from '@/modules/reporting/reporting.validation'
import { ReportControls } from '@/modules/reporting/ui/report-controls'

export const metadata: Metadata = { title: 'Advisor' }

/**
 * The AI restaurant manager.
 *
 * Every recommendation on this page is derived by arithmetic from figures the
 * system recorded, carries the figures it came from, and states how much
 * weight it can bear. A language model — where one is configured — writes only
 * the paragraph at the top, from conclusions it was handed and cannot check,
 * add to, or recalculate.
 *
 * The page is deliberately willing to say nothing. An advisor that always has
 * an opinion is one whose opinions are worth nothing, so both "there is not
 * enough trade to advise on" and "nothing is wrong" are ordinary outcomes here
 * rather than empty states to be filled.
 */
export default async function AdvisorPage({
  searchParams,
}: PageProps<'/advisor'>) {
  const ctx = await requirePermission('insight.view')
  const { restaurantId } = ctx.tenant

  const params = await searchParams
  const single = (key: string): string | undefined =>
    typeof params[key] === 'string' ? params[key] : undefined

  const query = reportQuerySchema.parse({
    from: single('from'),
    to: single('to'),
    branchId: single('branchId'),
  })

  const [resolved, branches] = await Promise.all([
    resolveReportRequest(restaurantId, ctx.user.id, query),
    listBranches(restaurantId, ctx.user.id),
  ])

  const report = await readAdvisorReport(
    resolved.ctx,
    resolved.filters.range,
    resolved.filters.branchId ?? null,
  )

  const canDismiss = ctx.tenant.permissions.has('insight.dismiss')

  const actionable = report.insights.filter(
    (insight) => insight.severity !== 'info',
  )
  const informational = report.insights.filter(
    (insight) => insight.severity === 'info',
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Advisor</h1>
        <p className="text-sm text-muted-foreground">
          {describeRange(
            resolved.filters.range,
            resolved.timeZone,
            resolved.ctx.businessDayStartMinutes,
          )}{' '}
          · recomputed every time you open this page
        </p>
      </div>

      <ReportControls
        report="advisor"
        from={resolved.fromIsoDate}
        to={resolved.toIsoDate}
        branchId={query.branchId ?? null}
        granularity={resolved.granularity}
        branches={branches.map((branch) => ({
          id: branch.id,
          name: branch.name,
        }))}
        showGranularity={false}
      />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" aria-hidden />
            <CardTitle className="text-base">The short version</CardTitle>
            {/*
              Named, not hidden. A reader should always know whether the words
              in front of them were written by a model or assembled from the
              findings — and either way, that the numbers were not.
            */}
            <Badge variant="outline" className="text-[10px] font-normal">
              {report.briefing.source === 'model'
                ? 'written by Claude'
                : 'written by the app'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm leading-relaxed">{report.briefing.summary}</p>

          {report.briefing.degraded && (
            <p className="text-xs text-muted-foreground">
              {report.briefing.degraded}
            </p>
          )}
        </CardContent>
      </Card>

      {report.refusal && (
        <Alert>
          <AlertDescription>
            {/*
              The refusal is the finding. A new restaurant does not need to be
              told its discount rate rose 40% on eleven bills, and telling it so
              is how an advisor teaches people to stop reading it.
            */}
            {report.refusal}
          </AlertDescription>
        </Alert>
      )}

      {actionable.length === 0 && !report.refusal && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nothing needs doing</CardTitle>
            <CardDescription>
              Every check came back clean over this period. Silence here is a
              real answer, and the most common one for a business with nothing
              wrong with it.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {actionable.length > 0 && (
        <div className="space-y-4">
          {actionable.map((insight) => (
            <InsightCard
              key={insight.key}
              insight={insight}
              currency={resolved.currency}
              canDismiss={canDismiss}
            />
          ))}
        </div>
      )}

      {informational.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">
            Worth knowing
          </h2>
          {informational.map((insight) => (
            <InsightCard
              key={insight.key}
              insight={insight}
              currency={resolved.currency}
              canDismiss={canDismiss}
            />
          ))}
        </div>
      )}

      {report.dismissed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Hidden by someone here
            </CardTitle>
            <CardDescription>
              These came up again this period and are being kept quiet. Shown so
              that a dismissal is a decision on the record rather than a gap
              nobody can account for.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y text-sm">
              {report.dismissed.map((row) => (
                <li
                  key={row.insightKey}
                  className="flex items-center justify-between gap-4 px-6 py-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{row.reason}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {row.insightKey}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {row.dismissedBy ?? 'Unknown'}
                    {row.snoozedUntil
                      ? ` · back on ${row.snoozedUntil.toLocaleDateString()}`
                      : ' · for good'}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Alert>
        <AlertDescription>
          Every figure above was computed from this restaurant&rsquo;s own
          records and is shown beside the finding it produced. No language model
          calculates, estimates or invents anything here &mdash; where one is
          configured, it writes the summary paragraph and nothing else.
        </AlertDescription>
      </Alert>
    </div>
  )
}
