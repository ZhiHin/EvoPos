import type { Metadata } from 'next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { listAttributeDefinitions } from '@/modules/menu/attribute.service'
import {
  buildCategoryTree,
  listCategories,
  type CategoryNode,
} from '@/modules/menu/category.service'
import { listItems } from '@/modules/menu/item.service'
import { listTags } from '@/modules/menu/tag.service'
import { CategoryFormDialog } from '@/modules/menu/ui/category-form-dialog'
import { ItemFormDialog } from '@/modules/menu/ui/item-form-dialog'
import { getSettings } from '@/modules/settings/settings.service'

export const metadata: Metadata = { title: 'Menu' }

const STATUS_VARIANT = {
  active: 'secondary',
  hidden: 'outline',
  archived: 'destructive',
} as const

function CategoryBranch({ nodes }: { nodes: CategoryNode[] }) {
  return (
    <ul className="space-y-1">
      {nodes.map((node) => (
        <li key={node.id}>
          <div
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            style={{ paddingLeft: `${(node.depth - 1) * 16 + 8}px` }}
          >
            <span className="truncate">{node.name}</span>
            {node.status === 'hidden' && (
              <Badge variant="outline" className="text-[10px]">
                hidden
              </Badge>
            )}
          </div>
          {node.children.length > 0 && <CategoryBranch nodes={node.children} />}
        </li>
      ))}
    </ul>
  )
}

export default async function MenuPage() {
  const ctx = await requirePermission('menu.item.view')

  const { restaurantId } = ctx.tenant
  const userId = ctx.user.id

  const [categories, items, tags, attributeDefinitions, settings] =
    await Promise.all([
      listCategories(restaurantId, userId),
      listItems(restaurantId, userId),
      listTags(restaurantId, userId),
      listAttributeDefinitions(restaurantId, userId),
      getSettings(restaurantId, userId),
    ])

  const tree = buildCategoryTree(categories)
  const categoryName = new Map(categories.map((c) => [c.id, c.name]))

  const canCreateItem = ctx.tenant.permissions.has('menu.item.create')
  const canEditItem = ctx.tenant.permissions.has('menu.item.update')
  const canCreateCategory = ctx.tenant.permissions.has('menu.category.create')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Menu</h1>
          <p className="text-sm text-muted-foreground">
            {items.length} item{items.length === 1 ? '' : 's'} across{' '}
            {categories.length} categor
            {categories.length === 1 ? 'y' : 'ies'}
          </p>
        </div>

        <div className="flex gap-2">
          {canCreateCategory && (
            <CategoryFormDialog
              tree={tree}
              trigger={<Button variant="outline">New category</Button>}
            />
          )}
          {canCreateItem && (
            <ItemFormDialog
              categories={categories}
              tags={tags}
              attributeDefinitions={attributeDefinitions}
              trigger={<Button>New item</Button>}
            />
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <aside className="space-y-2">
          <h2 className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Categories
          </h2>
          {tree.length === 0 ? (
            <p className="px-2 text-sm text-muted-foreground">
              No categories yet.
            </p>
          ) : (
            <CategoryBranch nodes={tree} />
          )}
        </aside>

        <div className="min-w-0">
          {items.length === 0 ? (
            <div className="rounded-lg border border-dashed p-12 text-center">
              <p className="text-sm text-muted-foreground">
                No menu items yet.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="hidden sm:table-cell">
                      Category
                    </TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Status</TableHead>
                    {canEditItem && <TableHead className="w-20" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-medium">{item.name}</div>
                        {item.isFeatured && (
                          <Badge variant="secondary" className="mt-1 text-[10px]">
                            featured
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">
                        {item.categoryId
                          ? (categoryName.get(item.categoryId) ?? '—')
                          : 'Uncategorised'}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatMoney(item.priceMinor, settings.currency)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[item.status]}>
                          {item.status}
                        </Badge>
                      </TableCell>
                      {canEditItem && (
                        <TableCell>
                          <ItemFormDialog
                            categories={categories}
                            tags={tags}
                            attributeDefinitions={attributeDefinitions}
                            item={item}
                            trigger={
                              <Button variant="ghost" size="sm">
                                Edit
                              </Button>
                            }
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
