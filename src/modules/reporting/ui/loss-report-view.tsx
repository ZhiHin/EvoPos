import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { formatMoney } from '@/lib/money'
import type { LossReport } from '../report.service'
import { Stat } from './stat'

function LineList({
  rows,
  empty,
  currency,
}: {
  rows: { label: string; by?: string | null; count: number; valueMinor: number }[]
  empty: string
  currency: string
}) {
  if (rows.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">{empty}</p>
  }

  return (
    <ul className="divide-y text-sm">
      {rows.map((row, index) => (
        <li
          key={`${row.label}:${row.by ?? ''}:${String(index)}`}
          className="flex items-center justify-between gap-4 px-6 py-3"
        >
          <span className="min-w-0">
            <span className="block truncate">{row.label}</span>
            {row.by && (
              <span className="text-xs text-muted-foreground">{row.by}</span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-4">
            <span className="text-xs tabular-nums text-muted-foreground">
              ×{row.count}
            </span>
            <span className="font-mono tabular-nums">
              {formatMoney(row.valueMinor, currency)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

export function LossReportView({
  report,
  currency,
}: {
  report: LossReport
  currency: string
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Given away"
          value={formatMoney(report.totalGivenAwayMinor, currency)}
          hint="Comps, promotions, voids and refunds together."
        />
        <Stat
          label="Refunded"
          value={formatMoney(report.refundsMinor, currency)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Comps and manual discounts</CardTitle>
          <CardDescription>
            {/*
              The person is named because the pattern that matters is usually
              one person's. This is also why the report needs report.financial
              and not the operational permission.
            */}
            Named by whoever applied them. Percentage discounts are counted but
            not totalled — they are stored as a rate, not an amount.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <LineList
            currency={currency}
            empty="Nothing was comped in this period."
            rows={report.manualDiscounts.map((line) => ({
              label: line.reason,
              by: line.appliedBy,
              count: line.count,
              valueMinor: line.valueMinor,
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Promotions and vouchers</CardTitle>
          <CardDescription>
            Rule-driven, so these are the cost of the offers rather than of
            anyone&rsquo;s judgement.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <LineList
            currency={currency}
            empty="No promotions were redeemed in this period."
            rows={report.promotions.map((line) => ({
              label: line.name,
              count: line.count,
              valueMinor: line.valueMinor,
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Voided items</CardTitle>
          <CardDescription>
            On bills settled in this period. A void after the food was cooked
            still cost the kitchen its ingredients.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <LineList
            currency={currency}
            empty="Nothing was voided in this period."
            rows={report.voids.map((line) => ({
              label: line.name,
              by: line.voidedBy,
              count: line.count,
              valueMinor: line.valueMinor,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  )
}
