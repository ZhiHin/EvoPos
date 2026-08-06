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
import type { BranchSummary } from '@/modules/branch/branch.repository'
import { BranchFormDialog } from './branch-form-dialog'

export function BranchList({
  branches,
  canEdit,
}: {
  branches: BranchSummary[]
  canEdit: boolean
}) {
  if (branches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          No branches yet. Create one to start setting up floors and tables.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Code</TableHead>
            <TableHead className="hidden sm:table-cell">City</TableHead>
            <TableHead>Status</TableHead>
            {canEdit && <TableHead className="w-20" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {branches.map((branch) => (
            <TableRow key={branch.id}>
              <TableCell className="font-medium">{branch.name}</TableCell>
              <TableCell className="font-mono text-xs">{branch.code}</TableCell>
              <TableCell className="hidden sm:table-cell">
                {branch.city ?? '—'}
              </TableCell>
              <TableCell>
                <Badge
                  variant={branch.status === 'active' ? 'secondary' : 'outline'}
                >
                  {branch.status}
                </Badge>
              </TableCell>
              {canEdit && (
                <TableCell>
                  <BranchFormDialog
                    branch={branch}
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
  )
}
