import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { requirePermission } from '@/lib/auth/context'
import { listBranches } from '@/modules/branch/branch.service'
import { BranchSwitcher } from '@/modules/branch/ui/branch-switcher'
import { listFloors } from '@/modules/floor/floor.service'
import { listTables } from '@/modules/table/table.service'
import { TableFormDialog } from '@/modules/table/ui/table-form-dialog'
import { TableGrid } from '@/modules/table/ui/table-grid'

export const metadata: Metadata = { title: 'Tables' }

export default async function TablesPage({
  searchParams,
}: PageProps<'/tables'>) {
  const ctx = await requirePermission('table.view')

  const branches = await listBranches(ctx.tenant.restaurantId, ctx.user.id)

  if (branches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          Create a branch before adding tables.
        </p>
      </div>
    )
  }

  const params = await searchParams
  const requested = typeof params.branch === 'string' ? params.branch : null

  /**
   * Falls back to the first branch when the query names one this member
   * cannot see, rather than erroring. The list came from a tenant-scoped
   * query, so an unmatched id is either stale or someone else's — neither
   * deserves an error page.
   */
  const branch = branches.find((b) => b.id === requested) ?? branches[0]

  const [floors, tables] = await Promise.all([
    listFloors(ctx.tenant.restaurantId, ctx.user.id, branch.id),
    listTables(ctx.tenant.restaurantId, ctx.user.id, branch.id),
  ])

  const canCreate = ctx.tenant.permissions.has('table.create')
  const canEdit = ctx.tenant.permissions.has('table.update')
  const canRotate = ctx.tenant.permissions.has('table.rotate_qr')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tables</h1>
          <p className="text-sm text-muted-foreground">
            {tables.length} table{tables.length === 1 ? '' : 's'} in{' '}
            {branch.name}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <BranchSwitcher branches={branches} value={branch.id} />
          {canCreate && (
            <TableFormDialog
              branchId={branch.id}
              floors={floors}
              trigger={<Button>New table</Button>}
            />
          )}
        </div>
      </div>

      <TableGrid
        tables={tables}
        floors={floors}
        branchId={branch.id}
        canEdit={canEdit}
        canRotate={canRotate}
      />
    </div>
  )
}
