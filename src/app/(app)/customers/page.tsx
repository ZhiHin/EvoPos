import type { Metadata } from 'next'

import { Badge } from '@/components/ui/badge'
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
import { listCustomers } from '@/modules/crm/customer.service'

export const metadata: Metadata = { title: 'Customers' }

export default async function CustomersPage() {
  const ctx = await requirePermission('customer.view')

  const customers = await listCustomers(ctx.tenant.restaurantId, ctx.user.id)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <p className="text-sm text-muted-foreground">
          Visits count settled bills a member was attached to. Attaching one at
          the till is what makes their points accrue.
        </p>
      </div>

      {customers.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            No members yet. They are signed up at the till, on the bill.
          </p>
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Points</TableHead>
                  <TableHead className="text-right">Visits</TableHead>
                  <TableHead className="text-right">Last visit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((customer) => (
                  <TableRow key={customer.id}>
                    <TableCell className="font-medium">
                      {customer.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {customer.phone ?? '—'}
                    </TableCell>
                    <TableCell>
                      {customer.tierName ? (
                        <Badge variant="secondary" className="text-[10px]">
                          {customer.tierName}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {customer.pointsBalance}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {customer.visitCount}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {customer.lastVisitAt
                        ? new Date(customer.lastVisitAt).toLocaleDateString()
                        : 'Never'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
