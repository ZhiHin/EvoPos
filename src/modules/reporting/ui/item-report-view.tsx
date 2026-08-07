import { Badge } from '@/components/ui/badge'
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
import type { ItemReport } from '../report.service'
import { BarChart } from './bar-chart'
import { formatPercent } from './stat'

export function ItemReportView({
  report,
  currency,
  canSeeCost,
}: {
  report: ItemReport
  currency: string
  /**
   * Cost and margin are hidden without `report.financial`. A prep list and a
   * food cost percentage are different documents, and the person who needs
   * the first often should not have the second.
   */
  canSeeCost: boolean
}) {
  const money = (minor: number): string => formatMoney(minor, currency)

  const uncosted = report.items.filter((item) => !item.isCosted).length

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Best sellers by revenue</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart
              data={report.items.slice(0, 10).map((item) => ({
                label: item.name,
                value: item.revenueMinor,
                caption: money(item.revenueMinor),
              }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By category</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart
              data={report.categories.map((category) => ({
                label: category.categoryName,
                value: category.revenueMinor,
                caption: money(category.revenueMinor),
              }))}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Every item sold</CardTitle>
          <CardDescription>
            {canSeeCost && uncosted > 0 ? (
              /*
                Named rather than hidden. An item with no recipe shows a blank
                cost, and a blank that is not explained gets read as zero — at
                which point the dish looks free to make.
              */
              <>
                {uncosted} of {report.items.length} items have no recipe, so
                their cost and margin are blank rather than zero.
              </>
            ) : (
              <>
                A dish renamed mid-period appears twice, once under each name —
                which is what the receipts say.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {report.items.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Nothing was sold in this period.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  {canSeeCost && (
                    <>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Margin</TableHead>
                    </>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.items.map((item) => (
                  <TableRow key={`${item.menuItemId ?? ''}:${item.name}`}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.categoryName ?? (
                        <Badge variant="outline" className="text-[10px]">
                          uncategorised
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.quantity}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {money(item.revenueMinor)}
                    </TableCell>
                    {canSeeCost && (
                      <>
                        <TableCell className="text-right font-mono tabular-nums">
                          {item.isCosted ? (
                            money(item.costMinor)
                          ) : (
                            <span
                              className="text-muted-foreground"
                              title="No recipe, so nothing to cost"
                            >
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {formatPercent(item.marginBasisPoints)}
                        </TableCell>
                      </>
                    )}
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
