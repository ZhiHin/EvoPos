import type { Metadata } from 'next'
import { desc, eq } from 'drizzle-orm'

import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { requireTenant } from '@/lib/auth/context'
import { withTenant } from '@/lib/db'
import { auditLog, branches } from '@/lib/db/schema'

export const metadata: Metadata = { title: 'Dashboard' }

/**
 * Phase 0 dashboard.
 *
 * Deliberately a foundation readout rather than a sales dashboard: the
 * operational metrics the spec calls for (sales, covers, kitchen queue) have
 * no data behind them until orders exist in Phase 5. What it does show is
 * that tenancy, RBAC and the audit trail are actually working end to end,
 * which is what Phase 0 is accountable for.
 */
export default async function DashboardPage() {
  const ctx = await requireTenant()

  const { branchRows, recentActivity } = await withTenant(
    { restaurantId: ctx.tenant.restaurantId, userId: ctx.user.id },
    async (tx) => {
      const [branchRows, recentActivity] = await Promise.all([
        tx
          .select({ id: branches.id, name: branches.name, code: branches.code })
          .from(branches)
          .where(eq(branches.restaurantId, ctx.tenant.restaurantId)),
        tx
          .select({
            id: auditLog.id,
            action: auditLog.action,
            entityType: auditLog.entityType,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .orderBy(desc(auditLog.createdAt))
          .limit(5),
      ])
      return { branchRows, recentActivity }
    },
  )

  const permissions = [...ctx.tenant.permissions].sort()

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {ctx.tenant.restaurantName}
        </h1>
        <p className="text-sm text-muted-foreground">
          Signed in as {ctx.user.name} · {ctx.tenant.roleName}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Branches</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {branchRows.length}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              {branchRows.length === 0
                ? 'No branches yet — added in Phase 1.'
                : branchRows.map((b) => b.name).join(', ')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Your permissions</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {permissions.length}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Granted by the {ctx.tenant.roleName} role.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Branch access</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {ctx.tenant.branchIds.length === 0
                ? 'All'
                : ctx.tenant.branchIds.length}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              {ctx.tenant.branchIds.length === 0
                ? 'Unrestricted across this restaurant.'
                : 'Limited to assigned branches.'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Permissions in this role</CardTitle>
          <CardDescription>
            Resolved server-side on every request from the {ctx.tenant.roleName}{' '}
            role. Hiding a control in the UI is never what enforces these.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {permissions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This role holds no staff permissions.
            </p>
          ) : (
            permissions.map((code) => (
              <Badge key={code} variant="secondary" className="font-mono">
                {code}
              </Badge>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
          <CardDescription>
            From the append-only audit trail. Scoped to this restaurant by
            row-level security, not by the query above.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recentActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {recentActivity.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-4 py-2"
                >
                  <span className="font-mono text-xs">{entry.action}</span>
                  <time
                    dateTime={entry.createdAt.toISOString()}
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {entry.createdAt.toLocaleString()}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
