import type { Metadata } from 'next'

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
import { readTakings } from '@/modules/payment/payment.service'
import { getSettings } from '@/modules/settings/settings.service'

export const metadata: Metadata = { title: 'Takings' }

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card_terminal: 'Card',
  ewallet_terminal: 'E-wallet',
  bank_transfer: 'Transfer',
  gateway: 'Online',
  other: 'Other',
}

/**
 * Daily takings, for reconciling the drawer.
 *
 * The day is bounded by when money moved, not by when a table opened — a
 * party seated at 23:30 and paid at 00:15 belongs to the day the cash went
 * in, because that is the day someone counts it.
 */
export default async function TakingsPage({
  searchParams,
}: PageProps<'/takings'>) {
  const ctx = await requirePermission('reconciliation.view')
  const { restaurantId } = ctx.tenant

  const params = await searchParams
  const requestedDate =
    typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
      ? params.date
      : new Date().toISOString().slice(0, 10)

  const from = new Date(`${requestedDate}T00:00:00`)
  const to = new Date(from)
  to.setDate(to.getDate() + 1)

  const [takings, settings] = await Promise.all([
    readTakings(restaurantId, ctx.user.id, from, to),
    getSettings(restaurantId, ctx.user.id),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Takings</h1>
        <p className="text-sm text-muted-foreground">
          {from.toLocaleDateString()} · counted by when payment was taken
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Net takings</CardDescription>
            <CardTitle className="font-mono text-3xl tabular-nums">
              {formatMoney(takings.netMinor, settings.currency)}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Refunded</CardDescription>
            <CardTitle className="font-mono text-3xl tabular-nums">
              {formatMoney(takings.refundedMinor, settings.currency)}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className={takings.expectedCashMinor > 0 ? 'border-primary' : undefined}>
          <CardHeader className="pb-2">
            <CardDescription>Expected in drawer</CardDescription>
            <CardTitle className="font-mono text-3xl tabular-nums">
              {formatMoney(takings.expectedCashMinor, settings.currency)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* The only figure that can be checked against something physical. */}
            <p className="text-xs text-muted-foreground">
              Cash only. Count the drawer against this; card and e-wallet
              reconcile against the terminal’s own settlement report.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By method</CardTitle>
        </CardHeader>
        <CardContent>
          {takings.byMethod.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No payments taken on this day.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Refunded</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {takings.byMethod.map((row) => (
                    <TableRow key={row.method}>
                      <TableCell className="font-medium">
                        {METHOD_LABEL[row.method] ?? row.method}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.count}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatMoney(row.grossMinor, settings.currency)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {row.refundedMinor === 0
                          ? '—'
                          : formatMoney(row.refundedMinor, settings.currency)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium tabular-nums">
                        {formatMoney(row.netMinor, settings.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
