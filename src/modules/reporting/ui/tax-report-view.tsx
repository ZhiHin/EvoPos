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
import type { TaxReport } from '../report.service'
import { Stat } from './stat'

export function TaxReportView({
  report,
  currency,
}: {
  report: TaxReport
  currency: string
}) {
  const money = (minor: number): string => formatMoney(minor, currency)

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Tax collected"
          value={money(report.totalTaxMinor)}
          hint="Net of anything refunded against these bills."
        />
        <Stat
          label="Taxable amount"
          value={money(report.totalTaxableMinor)}
          hint="Net sales plus service charge, which is itself taxable."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By rate</CardTitle>
          <CardDescription>
            {/*
              This is the whole reason the sales snapshot exists. A period
              spanning a rate change shows two lines, each with the tax
              genuinely charged under it — and a rate edited next year cannot
              retrospectively rewrite either.
            */}
            Grouped by the rate that was actually in force when each bill was
            settled, not by the rate configured today. A period spanning a rate
            change shows one line for each.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {report.lines.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No bills were settled in this period.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rate</TableHead>
                  <TableHead>Basis</TableHead>
                  <TableHead className="text-right">Bills</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">Service charge</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.lines.map((line) => (
                  <TableRow
                    key={`${line.rateBasisPoints}:${String(line.taxIsIncluded)}`}
                  >
                    <TableCell className="font-mono font-medium tabular-nums">
                      {(line.rateBasisPoints / 100).toFixed(2)}%
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {line.taxIsIncluded
                        ? 'Included in menu price'
                        : 'Added at checkout'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {line.bills}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {money(line.taxableBaseMinor)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {money(line.serviceChargeMinor)}
                    </TableCell>
                    <TableCell className="text-right font-mono font-medium tabular-nums">
                      {money(line.taxMinor)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
