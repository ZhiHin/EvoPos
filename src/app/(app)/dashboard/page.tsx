import type { Metadata } from 'next'
import Link from 'next/link'
import { desc } from 'drizzle-orm'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { requireTenant } from '@/lib/auth/context'
import { withTenant } from '@/lib/db'
import { auditLog } from '@/lib/db/schema'
import { formatMoney } from '@/lib/money'
import { listBranches } from '@/modules/branch/branch.service'
import { BranchSwitcher } from '@/modules/branch/ui/branch-switcher'
import { readLiveOperations } from '@/modules/reporting/operations.service'
import { Stat } from '@/modules/reporting/ui/stat'
import { getSettings } from '@/modules/settings/settings.service'

export const metadata: Metadata = { title: 'Dashboard' }

/**
 * Live operations.
 *
 * What is happening in the building right now: tables open, queue depth,
 * covers seated, today's trade so far. Nothing here is a trend — a trend is a
 * report, and this is a glance taken while walking past.
 *
 * Not everyone gets it. A kitchen role holds no reporting permission and lands
 * here after signing in, so the page degrades to their own access rather than
 * refusing them at the door.
 */
export default async function DashboardPage({
  searchParams,
}: PageProps<'/dashboard'>) {
  const ctx = await requireTenant()
  const { restaurantId } = ctx.tenant

  if (!ctx.tenant.permissions.has('report.view')) {
    return <PersonalView roleName={ctx.tenant.roleName} name={ctx.user.name} />
  }

  const params = await searchParams
  const requested = typeof params.branch === 'string' ? params.branch : null

  const [settings, branches] = await Promise.all([
    getSettings(restaurantId, ctx.user.id),
    listBranches(restaurantId, ctx.user.id),
  ])

  const branchId = branches.find((branch) => branch.id === requested)?.id ?? null

  const operations = await readLiveOperations(
    {
      restaurantId,
      userId: ctx.user.id,
      timeZone: settings.timezone,
      businessDayStartMinutes: settings.businessDayStartMinutes,
    },
    new Date(),
    branchId,
  )

  const money = (minor: number): string =>
    formatMoney(minor, settings.currency)

  /**
   * Only the things somebody should act on. A dashboard that always shows six
   * alert cards trains people to stop reading them, so each of these appears
   * only when its number is not zero.
   */
  const alerts = [
    operations.openServiceRequests > 0 && {
      label: 'Waiter calls waiting',
      value: operations.openServiceRequests,
      href: '/floor' as const,
    },
    operations.waitingParties > 0 && {
      label: 'Parties on the waiting list',
      value: operations.waitingParties,
      href: '/bookings' as const,
    },
    operations.upcomingBookings > 0 && {
      label: 'Bookings in the next 4 hours',
      value: operations.upcomingBookings,
      href: '/bookings' as const,
    },
    operations.lowStockCount > 0 && {
      label: 'Ingredients at or below reorder point',
      value: operations.lowStockCount,
      href: '/inventory' as const,
    },
  ].filter((alert) => alert !== false)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {ctx.tenant.restaurantName}
          </h1>
          <p className="text-sm text-muted-foreground">
            Trading day{' '}
            {operations.businessDay.from.toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}{' '}
            · {settings.timezone}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {branches.length > 1 && (
            <BranchSwitcher
              branches={[
                { id: '', name: 'All branches' },
                ...branches.map((branch) => ({
                  id: branch.id,
                  name: branch.name,
                })),
              ]}
              value={branchId ?? ''}
            />
          )}
          {ctx.tenant.permissions.has('report.financial') && (
            <Button asChild variant="outline">
              <Link href="/reports">Reports</Link>
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Open bills"
          value={String(operations.openBills)}
          hint={
            operations.seatedCovers > 0
              ? `${operations.seatedCovers} covers seated`
              : 'Nobody counted at the tables'
          }
        />
        <Stat
          label="On tables now"
          value={money(operations.openValueMinor)}
          // Subtotal, not total: running the full bill engine over every open
          // table on each refresh is not what that engine is for.
          hint="Items ordered, before tax and service"
        />
        <Stat
          label="Settled today"
          value={money(operations.netSalesTodayMinor)}
          hint={`${operations.settledBills} bills · ${money(operations.averageBillTodayMinor)} average`}
        />
        <Stat
          label="Kitchen queue"
          value={String(operations.kitchenQueue)}
          hint={
            operations.oldestTicketMinutes === null
              ? 'Nothing waiting'
              : `Oldest ordered ${operations.oldestTicketMinutes} min ago`
          }
          className={
            operations.oldestTicketMinutes !== null &&
            operations.oldestTicketMinutes >= 20
              ? 'border-destructive'
              : undefined
          }
        />
      </div>

      {alerts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Needs attention</CardTitle>
            <CardDescription>
              Only what is not zero. A dashboard that always shows the same six
              warnings teaches people to stop reading them.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y text-sm">
              {alerts.map((alert) => (
                <li key={alert.label}>
                  <Link
                    href={alert.href}
                    className="flex items-center justify-between px-6 py-3 hover:bg-accent/50"
                  >
                    <span>{alert.label}</span>
                    <Badge variant="secondary" className="tabular-nums">
                      {alert.value}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Staff clocked in"
          value={String(operations.staffOnShift)}
          hint="Anyone with an open punch"
        />
        <Stat
          label="Waiting list"
          value={String(operations.waitingParties)}
          hint="Parties waiting or called"
        />
      </div>
    </div>
  )
}

/**
 * What someone without reporting access sees.
 *
 * Deliberately not an empty page or a 403. This is where every sign-in lands,
 * and a kitchen porter arriving at an error message reasonably concludes the
 * software is broken rather than that it is working as designed.
 */
async function PersonalView({
  roleName,
  name,
}: {
  roleName: string
  name: string
}) {
  const ctx = await requireTenant()

  const recentActivity = await withTenant(
    { restaurantId: ctx.tenant.restaurantId, userId: ctx.user.id },
    (tx) =>
      tx
        .select({
          id: auditLog.id,
          action: auditLog.action,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .orderBy(desc(auditLog.createdAt))
        .limit(5),
  )

  const permissions = [...ctx.tenant.permissions].sort()

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {ctx.tenant.restaurantName}
        </h1>
        <p className="text-sm text-muted-foreground">
          Signed in as {name} · {roleName}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What you can do here</CardTitle>
          <CardDescription>
            Resolved server-side on every request from the {roleName} role.
            Hiding a control in the UI is never what enforces these.
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

      {recentActivity.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>
              From the append-only audit trail. Scoped to this restaurant by
              row-level security, not by the query that read it.
            </CardDescription>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      )}
    </div>
  )
}
