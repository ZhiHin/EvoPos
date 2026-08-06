import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { listBranches } from '@/modules/branch/branch.service'
import { listIngredients } from '@/modules/inventory/inventory.service'
import {
  listPurchaseOrders,
  listSuppliers,
} from '@/modules/inventory/purchasing.service'
import { PurchaseOrderDialog } from '@/modules/inventory/ui/purchase-order-dialog'
import { SupplierDialog } from '@/modules/inventory/ui/supplier-dialog'
import { getSettings } from '@/modules/settings/settings.service'

export const metadata: Metadata = { title: 'Purchase orders' }

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

export default async function PurchaseOrdersPage() {
  const ctx = await requirePermission('purchase.view')
  const { restaurantId } = ctx.tenant

  const [orders, suppliers, ingredients, branches, settings] =
    await Promise.all([
      listPurchaseOrders(restaurantId, ctx.user.id),
      listSuppliers(restaurantId, ctx.user.id),
      listIngredients(restaurantId, ctx.user.id),
      listBranches(restaurantId, ctx.user.id),
      getSettings(restaurantId, ctx.user.id),
    ])

  const canCreate = ctx.tenant.permissions.has('purchase.create')
  const canManageSuppliers = ctx.tenant.permissions.has('supplier.manage')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Purchase orders
          </h1>
          <p className="text-sm text-muted-foreground">
            Raised, approved by someone else, then received — partially if
            that is what turned up.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/inventory">Stock</Link>
          </Button>
          {canManageSuppliers && (
            <SupplierDialog
              trigger={<Button variant="outline">New supplier</Button>}
            />
          )}
          {canCreate && suppliers.length > 0 && branches.length > 0 && (
            <PurchaseOrderDialog
              suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
              branches={branches.map((b) => ({ id: b.id, name: b.name }))}
              ingredients={ingredients.map((i) => ({
                id: i.id,
                name: i.name,
                unit: i.unit,
                costPerUnitMinor: i.costPerUnitMinor,
              }))}
              trigger={<Button>New order</Button>}
            />
          )}
        </div>
      </div>

      {suppliers.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            No suppliers yet. Add one before raising an order.
          </p>
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            No purchase orders yet.
          </p>
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => {
                  const status =
                    STATUS_LABEL[order.status] ?? STATUS_LABEL.draft

                  return (
                    <TableRow key={order.id}>
                      <TableCell>
                        <Link
                          href={`/inventory/purchase-orders/${order.id}`}
                          className="font-mono text-sm hover:underline"
                        >
                          {order.reference}
                        </Link>
                      </TableCell>
                      <TableCell>{order.supplierName}</TableCell>
                      <TableCell>
                        <Badge variant={status.variant} className="text-[10px]">
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {order.expectedAt
                          ? order.expectedAt.toLocaleDateString()
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatMoney(order.totalMinor, settings.currency)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
