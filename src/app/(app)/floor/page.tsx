import type { Metadata } from 'next'
import Link from 'next/link'
import { and, eq, inArray } from 'drizzle-orm'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { requirePermission } from '@/lib/auth/context'
import { withTenant } from '@/lib/db'
import { diningSessionMembers, serviceRequests } from '@/lib/db/schema'
import { formatMoney } from '@/lib/money'
import { listBranches } from '@/modules/branch/branch.service'
import { BranchSwitcher } from '@/modules/branch/ui/branch-switcher'
import { computeSessionTotals } from '@/modules/pos/pos.service'
import { ResolveRequestButton } from '@/modules/pos/ui/session-actions'
import { listLiveSessions } from '@/modules/session/session.service'
import { getSettings } from '@/modules/settings/settings.service'

export const metadata: Metadata = { title: 'Floor' }

const TYPE_LABEL = {
  dine_in: 'Dine in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
} as const

const REQUEST_LABEL = {
  call_waiter: 'Waiter called',
  request_bill: 'Bill requested',
} as const

/**
 * The live floor.
 *
 * This is the screen Phase 4 left missing — waiter calls were landing in the
 * database with nothing displaying them, which made the whole call-waiter
 * feature decorative.
 */
export default async function FloorPage({
  searchParams,
}: PageProps<'/floor'>) {
  const ctx = await requirePermission('session.view')
  const { restaurantId } = ctx.tenant
  const userId = ctx.user.id

  const [branches, settings] = await Promise.all([
    listBranches(restaurantId, userId),
    getSettings(restaurantId, userId),
  ])

  if (branches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          Create a branch before taking orders.
        </p>
      </div>
    )
  }

  const params = await searchParams
  const requested = typeof params.branch === 'string' ? params.branch : null
  const branch = branches.find((b) => b.id === requested) ?? branches[0]

  const sessions = await listLiveSessions(restaurantId, userId, branch.id)

  /**
   * Totals and open requests are fetched per session. At a realistic floor
   * size (tens of live tables) this is fine; if a chain ever runs hundreds of
   * concurrent sessions on one screen it wants a single aggregate query, and
   * that is a change worth making against a measurement rather than a guess.
   */
  const detail = await withTenant({ restaurantId, userId }, async (tx) => {
    const ids = sessions.map((s) => s.id)

    const [requests, members] =
      ids.length === 0
        ? [[], []]
        : await Promise.all([
            tx
              .select({
                id: serviceRequests.id,
                sessionId: serviceRequests.sessionId,
                type: serviceRequests.type,
              })
              .from(serviceRequests)
              .where(
                and(
                  inArray(serviceRequests.sessionId, ids),
                  eq(serviceRequests.status, 'open'),
                ),
              ),
            tx
              .select({
                sessionId: diningSessionMembers.sessionId,
                displayName: diningSessionMembers.displayName,
              })
              .from(diningSessionMembers)
              .where(inArray(diningSessionMembers.sessionId, ids)),
          ])

    const totals = new Map<string, number>()
    for (const session of sessions) {
      const computed = await computeSessionTotals(tx, restaurantId, session.id)
      totals.set(session.id, computed.totalMinor)
    }

    return { requests, members, totals }
  })

  const canResolve = ctx.tenant.permissions.has('service.resolve')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Floor</h1>
          <p className="text-sm text-muted-foreground">
            {sessions.length} open bill{sessions.length === 1 ? '' : 's'} in{' '}
            {branch.name}
          </p>
        </div>

        <BranchSwitcher branches={branches} value={branch.id} />
      </div>

      {sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing open right now. Sessions appear here when a table is seated
            or a diner scans a QR code.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((session) => {
            const requests = detail.requests.filter(
              (r) => r.sessionId === session.id,
            )
            const members = detail.members.filter(
              (m) => m.sessionId === session.id,
            )

            return (
              <Card
                key={session.id}
                className={
                  requests.length > 0 ? 'border-primary shadow-sm' : undefined
                }
              >
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={`/floor/${session.id}`}
                        className="font-mono text-lg font-semibold hover:underline"
                      >
                        {session.tableCode ?? TYPE_LABEL[session.type]}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {session.type === 'dine_in'
                          ? `${members.length} diner${members.length === 1 ? '' : 's'}`
                          : (session.customerName ?? 'No name given')}
                      </div>
                    </div>

                    <Badge
                      variant={
                        session.status === 'bill_requested'
                          ? 'default'
                          : 'secondary'
                      }
                    >
                      {session.status === 'bill_requested'
                        ? 'bill requested'
                        : TYPE_LABEL[session.type]}
                    </Badge>
                  </div>

                  <div className="font-mono text-xl tabular-nums">
                    {formatMoney(
                      detail.totals.get(session.id) ?? 0,
                      settings.currency,
                    )}
                  </div>

                  {requests.length > 0 && (
                    <ul className="space-y-1">
                      {requests.map((request) => (
                        <li
                          key={request.id}
                          className="flex items-center justify-between gap-2 rounded-md bg-accent px-2 py-1.5 text-xs"
                        >
                          <span>{REQUEST_LABEL[request.type]}</span>
                          {canResolve && (
                            <ResolveRequestButton requestId={request.id} />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
