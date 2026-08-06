import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { requirePermission } from '@/lib/auth/context'
import { listBranches } from '@/modules/branch/branch.service'
import { BranchSwitcher } from '@/modules/branch/ui/branch-switcher'
import {
  listStations,
  readKitchenQueue,
} from '@/modules/kitchen/kitchen.service'
import { TicketCard } from '@/modules/kitchen/ui/ticket-card'

export const metadata: Metadata = { title: 'Kitchen' }

/**
 * The kitchen display.
 *
 * Revalidates every 15 seconds. Real-time push would be better and is the
 * obvious next step, but polling is honest, has no infrastructure, and a
 * fifteen-second lag on a dish that takes eight minutes to cook is not what
 * loses a service. Swapping in SSE later changes this line and nothing else.
 */
export const revalidate = 15

export default async function KdsPage({ searchParams }: PageProps<'/kds'>) {
  const ctx = await requirePermission('kitchen.view')
  const { restaurantId } = ctx.tenant
  const userId = ctx.user.id

  const branches = await listBranches(restaurantId, userId)

  if (branches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          Create a branch before using the kitchen display.
        </p>
      </div>
    )
  }

  const params = await searchParams
  const branch =
    branches.find(
      (b) => typeof params.branch === 'string' && b.id === params.branch,
    ) ?? branches[0]

  const stationId =
    typeof params.station === 'string' ? params.station : undefined

  const [stations, queue] = await Promise.all([
    listStations(restaurantId, userId, branch.id),
    readKitchenQueue(restaurantId, userId, branch.id, stationId),
  ])

  const outstanding = queue.reduce((sum, t) => sum + t.lines.length, 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Kitchen</h1>
          <p className="text-sm text-muted-foreground">
            {outstanding} item{outstanding === 1 ? '' : 's'} outstanding in{' '}
            {branch.name}
          </p>
        </div>

        <BranchSwitcher branches={branches} value={branch.id} />
      </div>

      {stations.length > 0 && (
        <nav className="flex flex-wrap gap-2" aria-label="Stations">
          <Link
            href={`/kds?branch=${branch.id}`}
            className={
              stationId
                ? 'min-h-11 rounded-md border px-3 py-2 text-sm hover:bg-accent'
                : 'min-h-11 rounded-md border border-primary bg-primary px-3 py-2 text-sm text-primary-foreground'
            }
          >
            All
          </Link>

          {stations
            .filter((s) => s.isActive)
            .map((station) => (
              <Link
                key={station.id}
                href={`/kds?branch=${branch.id}&station=${station.id}`}
                className={
                  stationId === station.id
                    ? 'min-h-11 rounded-md border border-primary bg-primary px-3 py-2 text-sm text-primary-foreground'
                    : 'min-h-11 rounded-md border px-3 py-2 text-sm hover:bg-accent'
                }
              >
                {station.name}
                {station.isDefault && (
                  <Badge variant="secondary" className="ml-2 text-[10px]">
                    default
                  </Badge>
                )}
              </Link>
            ))}
        </nav>
      )}

      {stations.length === 0 && (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No stations configured for this branch, so every outstanding item is
          shown together. Create stations to route dishes to separate screens.
        </div>
      )}

      {queue.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing to make. Tickets appear here the moment an order is placed.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {queue.map((ticket) => (
            <TicketCard key={ticket.sessionId} ticket={ticket} />
          ))}
        </div>
      )}
    </div>
  )
}
