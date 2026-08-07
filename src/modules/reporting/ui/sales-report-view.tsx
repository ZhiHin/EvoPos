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
import { formatMoney } from '@/lib/money'
import type { SalesReport } from '../report.service'
import { BarChart } from './bar-chart'
import { formatPercent, Stat } from './stat'

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card_terminal: 'Card',
  ewallet_terminal: 'E-wallet',
  bank_transfer: 'Transfer',
  gateway: 'Online',
  other: 'Other',
}

const TYPE_LABEL: Record<string, string> = {
  dine_in: 'Dine-in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
}

export function SalesReportView({
  report,
  currency,
  timeZone,
}: {
  report: SalesReport
  currency: string
  timeZone: string
}) {
  const money = (minor: number): string => formatMoney(minor, currency)
  const { summary } = report

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Net sales"
          value={money(summary.netSalesMinor)}
          comparison={report.netSales}
          hint="Excluding tax and service charge, less refunds."
        />
        <Stat
          label="Bills"
          value={String(summary.bills)}
          comparison={report.bills}
        />
        <Stat
          label="Covers"
          value={String(summary.covers)}
          comparison={report.covers}
          hint={
            summary.covers === 0
              ? 'Nobody was counted on these bills.'
              : undefined
          }
        />
        <Stat
          label="Average bill"
          value={money(summary.averageBillMinor)}
          hint={
            summary.covers > 0
              ? `${money(summary.averagePerCoverMinor)} per cover`
              : undefined
          }
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Discounts" value={money(summary.discountMinor)} />
        <Stat
          label="Service charge"
          value={money(summary.serviceChargeMinor)}
        />
        <Stat label="Tax" value={money(summary.taxMinor)} />
        <Stat
          label="Refunded"
          value={money(summary.refundedMinor)}
          hint="Against bills settled in this period, whenever refunded."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gross profit</CardTitle>
          <CardDescription>
            {summary.costCoverageBasisPoints === null ? (
              'Nothing sold in this period.'
            ) : summary.costCoverageBasisPoints >= 9_000 ? (
              <>
                {formatPercent(summary.costCoverageBasisPoints)} of sales have a
                recipe behind them, so this margin covers almost the whole menu.
              </>
            ) : (
              /*
                Stated in the open rather than footnoted. A margin computed
                over a partly-costed menu is a margin on the costed part, and
                an owner reading 85% needs to know it is 85% of a fifth.
              */
              <>
                Only {formatPercent(summary.costCoverageBasisPoints)} of sales
                have a recipe behind them. This margin describes that part of
                the menu, not the whole of it.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Net sales</p>
            <p className="font-mono text-xl tabular-nums">
              {money(summary.netSalesMinor)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Cost of sales</p>
            <p className="font-mono text-xl tabular-nums">
              {money(summary.costMinor)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              Gross profit · {formatPercent(summary.marginBasisPoints)}
            </p>
            <p className="font-mono text-xl tabular-nums">
              {money(summary.grossProfitMinor)}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Net sales by {report.granularity}
            </CardTitle>
            <CardDescription>
              Periods with no trade are left out rather than drawn as zero.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              data={report.series.map((bucket) => ({
                label: bucket.key,
                value: bucket.summary.netSalesMinor,
                caption: money(bucket.summary.netSalesMinor),
              }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Shape of the day</CardTitle>
            <CardDescription>
              Bills settled by hour, in {timeZone}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              data={report.byHour
                .filter((hour) => hour.bills > 0)
                .map((hour) => ({
                  label: `${String(hour.hour).padStart(2, '0')}:00`,
                  value: hour.bills,
                  caption: `${hour.bills}`,
                }))}
            />
          </CardContent>
        </Card>
      </div>

      {report.byBranch.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By branch</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right">Bills</TableHead>
                  <TableHead className="text-right">Covers</TableHead>
                  <TableHead className="text-right">Net sales</TableHead>
                  <TableHead className="text-right">Average bill</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.byBranch.map((line) => (
                  <TableRow key={line.branchId}>
                    <TableCell className="font-medium">
                      {line.name}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {line.code}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {line.summary.bills}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {line.summary.covers}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {money(line.summary.netSalesMinor)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {money(line.summary.averageBillMinor)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">How people paid</CardTitle>
            <CardDescription>
              Payments taken against these bills. Reconcile cash against the
              drawer on the takings page, which counts by when money moved.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {report.byMethod.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No payments in this period.
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {report.byMethod.map((line) => (
                  <li
                    key={line.method}
                    className="flex items-center justify-between px-6 py-3"
                  >
                    <span>{METHOD_LABEL[line.method] ?? line.method}</span>
                    <span className="flex items-center gap-4">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {line.count}
                      </span>
                      <span className="font-mono tabular-nums">
                        {money(line.amountMinor)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Service type</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {report.byType.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No trade in this period.
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {report.byType.map((line) => (
                  <li
                    key={line.type}
                    className="flex items-center justify-between px-6 py-3"
                  >
                    <span>{TYPE_LABEL[line.type] ?? line.type}</span>
                    <span className="flex items-center gap-4">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {line.summary.bills} bills
                      </span>
                      <span className="font-mono tabular-nums">
                        {money(line.summary.netSalesMinor)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
