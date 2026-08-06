import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { requirePermission } from '@/lib/auth/context'
import { NotFoundError } from '@/lib/errors'
import { formatMoney } from '@/lib/money'
import { readPurchaseOrder } from '@/modules/inventory/purchasing.service'
import { formatQuantity } from '@/modules/inventory/stock'
import { PurchaseOrderActions } from '@/modules/inventory/ui/purchase-order-actions'
import { ReceiveGoodsDialog } from '@/modules/inventory/ui/receive-goods-dialog'
import { getSettings } from '@/modules/settings/settings.service'

export const metadata: Metadata = { title: 'Purchase order' }

const STATUS_LABEL: Record<
  string,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  draft: { label: 'Draft', variant: 'outline' },
  approved: { label: 'Approved', variant: 'default' },
  partially_received: { label: 'Part received', variant: 'secondary' },
  received: { label: 'Received', variant: 'secondary' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
}

export default async function PurchaseOrderPage({
  params,
}: PageProps<'/inventory/purchase-orders/[purchaseOrderId]'>) {
  const ctx = await requirePermission('purchase.view')
  const { purchaseOrderId } = await params

  const order = await readPurchaseOrder(
    ctx.tenant.restaurantId,
    ctx.user.id,
    purchaseOrderId,
  ).catch((cause) => {
    if (cause instanceof NotFoundError) notFound()
    throw cause
  })

  const settings = await getSettings(ctx.tenant.restaurantId, ctx.user.id)

  const status = STATUS_LABEL[order.status] ?? STATUS_LABEL.draft
  const outstanding = order.lines.filter(
    (line) => line.receivedMilli < line.orderedMilli,
  )

  const canReceive =
    ctx.tenant.permissions.has('purchase.receive') &&
    (order.status === 'approved' || order.status === 'partially_received') &&
    outstanding.length > 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/inventory/purchase-orders"
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Purchase orders
          </Link>
          <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
            <span className="font-mono">{order.reference}</span>
            <Badge variant={status.variant}>{status.label}</Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            {order.supplierName}
            {order.expectedAt &&
              ` · expected ${order.expectedAt.toLocaleDateString()}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <PurchaseOrderActions
            purchaseOrderId={order.id}
            status={order.status}
            canApprove={ctx.tenant.permissions.has('purchase.approve')}
            canCancel={ctx.tenant.permissions.has('purchase.cancel')}
          />
          {canReceive && (
            <ReceiveGoodsDialog
              purchaseOrderId={order.id}
              lines={outstanding}
              trigger={<Button>Receive goods</Button>}
            />
          )}
        </div>
      </div>

      {order.status === 'draft' && (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          Awaiting approval. Goods cannot be received against a draft, and it
          must be approved by someone other than whoever raised it.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ingredient</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.lines.map((line) => {
                const complete = line.receivedMilli >= line.orderedMilli

                return (
                  <TableRow key={line.id}>
                    <TableCell>{line.name}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatQuantity(line.orderedMilli, line.unit)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono tabular-nums ${
                        complete ? '' : 'text-muted-foreground'
                      }`}
                    >
                      {formatQuantity(line.receivedMilli, line.unit)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatMoney(line.unitCostMinor, settings.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatMoney(
                        Math.round(
                          (line.orderedMilli * line.unitCostMinor) / 1000,
                        ),
                        settings.currency,
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <dl className="w-full max-w-xs space-y-2 text-sm">
          <div className="flex justify-between border-t pt-2 text-base font-semibold">
            <dt>Order total</dt>
            <dd className="font-mono tabular-nums">
              {formatMoney(order.totalMinor, settings.currency)}
            </dd>
          </div>
        </dl>
      </div>

      {order.notes && (
        <p className="text-sm text-muted-foreground">{order.notes}</p>
      )}
    </div>
  )
}
