import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { listBranches } from '@/modules/branch/branch.service'
import { BranchSwitcher } from '@/modules/branch/ui/branch-switcher'
import {
  listReorderSuggestions,
  listStock,
} from '@/modules/inventory/inventory.service'
import { listIngredients } from '@/modules/inventory/inventory.service'
import { formatQuantity } from '@/modules/inventory/stock'
import { CountDialog } from '@/modules/inventory/ui/count-dialog'
import { IngredientDialog } from '@/modules/inventory/ui/ingredient-dialog'
import { WastageDialog } from '@/modules/inventory/ui/wastage-dialog'
import { getSettings } from '@/modules/settings/settings.service'

export const metadata: Metadata = { title: 'Inventory' }

const STATUS_STYLE = {
  out: { label: 'Out', variant: 'destructive' as const },
  low: { label: 'Low', variant: 'secondary' as const },
  ok: { label: '', variant: 'outline' as const },
}

export default async function InventoryPage({
  searchParams,
}: PageProps<'/inventory'>) {
  const ctx = await requirePermission('stock.view')
  const { restaurantId } = ctx.tenant

  const branches = await listBranches(restaurantId, ctx.user.id)

  if (branches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          Stock is held per branch. Create a branch first.
        </p>
      </div>
    )
  }

  const params = await searchParams
  const requested = typeof params.branch === 'string' ? params.branch : null
  const branchId =
    branches.find((branch) => branch.id === requested)?.id ?? branches[0].id

  const [stock, reorder, ingredients, settings] = await Promise.all([
    listStock(restaurantId, ctx.user.id, branchId),
    listReorderSuggestions(restaurantId, ctx.user.id, branchId),
    listIngredients(restaurantId, ctx.user.id),
    getSettings(restaurantId, ctx.user.id),
  ])

  const canManage = ctx.tenant.permissions.has('ingredient.manage')
  const canCount = ctx.tenant.permissions.has('stock.count')
  const canWaste = ctx.tenant.permissions.has('stock.waste')

  const totalValueMinor = stock.reduce((sum, row) => sum + row.valueMinor, 0)
  const attention = stock.filter((row) => row.status !== 'ok')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground">
            Levels move as orders are placed. Every change is on the ledger.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <BranchSwitcher branches={branches} value={branchId} />
          {ctx.tenant.permissions.has('purchase.view') && (
            <Button variant="outline" asChild>
              <Link href="/inventory/purchase-orders">Purchase orders</Link>
            </Button>
          )}
          {canManage && (
            <IngredientDialog trigger={<Button>New ingredient</Button>} />
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Stock value</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {formatMoney(totalValueMinor, settings.currency)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Needs attention</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {attention.length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Ingredients tracked</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {stock.length}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {reorder.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Suggested order</CardTitle>
            <CardDescription>
              Tops each ingredient back up to its reorder point plus its
              standard order quantity.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {reorder.map((item) => (
                <li
                  key={item.ingredientId}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{item.name}</span>
                    <Badge
                      variant={STATUS_STYLE[item.status].variant}
                      className="text-[10px]"
                    >
                      {STATUS_STYLE[item.status].label}
                    </Badge>
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums">
                    {formatQuantity(item.suggestedMilli, item.unit)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {stock.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            No ingredients yet. Add one, then set what each dish consumes so
            stock moves by itself when an order is placed.
          </p>
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ingredient</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Cost / unit</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">Counted</TableHead>
                  {(canCount || canWaste) && (
                    <TableHead className="w-1 text-right" />
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {stock.map((row) => (
                  <TableRow key={row.ingredientId}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        {row.name}
                        {row.status !== 'ok' && (
                          <Badge
                            variant={STATUS_STYLE[row.status].variant}
                            className="text-[10px]"
                          >
                            {STATUS_STYLE[row.status].label}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.category ?? '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatQuantity(row.quantityMilli, row.unit)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatMoney(row.costPerUnitMinor, settings.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatMoney(row.valueMinor, settings.currency)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {row.lastCountedAt
                        ? row.lastCountedAt.toLocaleDateString()
                        : 'Never'}
                    </TableCell>
                    {(canCount || canWaste) && (
                      <TableCell className="text-right">
                        <span className="flex justify-end gap-1">
                          {canCount && (
                            <CountDialog
                              branchId={branchId}
                              ingredient={row}
                              trigger={
                                <Button variant="ghost" size="sm">
                                  Count
                                </Button>
                              }
                            />
                          )}
                          {canWaste && (
                            <WastageDialog
                              branchId={branchId}
                              ingredient={row}
                              trigger={
                                <Button variant="ghost" size="sm">
                                  Waste
                                </Button>
                              }
                            />
                          )}
                        </span>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {canManage && ingredients.length > stock.length && (
        <p className="text-xs text-muted-foreground">
          {ingredients.length - stock.length} inactive ingredient
          {ingredients.length - stock.length === 1 ? '' : 's'} hidden.
        </p>
      )}
    </div>
  )
}
