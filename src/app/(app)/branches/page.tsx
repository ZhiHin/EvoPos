import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { requirePermission } from '@/lib/auth/context'
import { listBranches } from '@/modules/branch/branch.service'
import { BranchFormDialog } from '@/modules/branch/ui/branch-form-dialog'
import { BranchList } from '@/modules/branch/ui/branch-list'

export const metadata: Metadata = { title: 'Branches' }

export default async function BranchesPage() {
  // This guard is the enforcement. The sidebar hiding the link is not.
  const ctx = await requirePermission('branch.view')

  const branches = await listBranches(ctx.tenant.restaurantId, ctx.user.id)
  const canCreate = ctx.tenant.permissions.has('branch.create')
  const canEdit = ctx.tenant.permissions.has('branch.update')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Branches</h1>
          <p className="text-sm text-muted-foreground">
            Each branch has its own floors, tables and staff assignments.
          </p>
        </div>

        {canCreate && (
          <BranchFormDialog trigger={<Button>New branch</Button>} />
        )}
      </div>

      <BranchList branches={branches} canEdit={canEdit} />
    </div>
  )
}
