import type { Metadata } from 'next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { requirePermission } from '@/lib/auth/context'
import { listBranches } from '@/modules/branch/branch.service'
import { BranchSwitcher } from '@/modules/branch/ui/branch-switcher'
import {
  listReservations,
  listWaitlist,
} from '@/modules/reservation/reservation.service'
import { ReservationDialog } from '@/modules/reservation/ui/reservation-dialog'
import { ReservationRow } from '@/modules/reservation/ui/reservation-row'
import { WaitlistDialog } from '@/modules/reservation/ui/waitlist-dialog'
import { WaitlistRow } from '@/modules/reservation/ui/waitlist-row'
import { listTables } from '@/modules/table/table.service'

export const metadata: Metadata = { title: 'Bookings' }

export default async function BookingsPage({
  searchParams,
}: PageProps<'/bookings'>) {
  const ctx = await requirePermission('reservation.view')
  const { restaurantId } = ctx.tenant

  const branches = await listBranches(restaurantId, ctx.user.id)

  if (branches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          Bookings are taken per branch. Create a branch first.
        </p>
      </div>
    )
  }

  const params = await searchParams
  const requested = typeof params.branch === 'string' ? params.branch : null
  const branchId =
    branches.find((branch) => branch.id === requested)?.id ?? branches[0].id

  const date =
    typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
      ? params.date
      : new Date().toISOString().slice(0, 10)

  const from = new Date(`${date}T00:00:00`)
  const to = new Date(from)
  to.setDate(to.getDate() + 1)

  const canSeeWaitlist = ctx.tenant.permissions.has('waitlist.view')

  const [reservations, waitlist, tables] = await Promise.all([
    listReservations(restaurantId, ctx.user.id, branchId, from, to),
    canSeeWaitlist
      ? listWaitlist(restaurantId, ctx.user.id, branchId)
      : Promise.resolve([]),
    listTables(restaurantId, ctx.user.id, branchId),
  ])

  const canCreate = ctx.tenant.permissions.has('reservation.create')
  const canSeat = ctx.tenant.permissions.has('reservation.seat')
  const canCancel = ctx.tenant.permissions.has('reservation.cancel')
  const canManageWaitlist = ctx.tenant.permissions.has('waitlist.manage')

  const upcoming = reservations.filter(
    (r) => r.status === 'pending' || r.status === 'confirmed',
  )
  const settled = reservations.filter(
    (r) => r.status !== 'pending' && r.status !== 'confirmed',
  )

  const covers = upcoming.reduce((sum, r) => sum + r.partySize, 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bookings</h1>
          <p className="text-sm text-muted-foreground">
            Seating a booking opens its bill, so the table behaves exactly as a
            walk-in from then on.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <BranchSwitcher branches={branches} value={branchId} />
          {canManageWaitlist && (
            <WaitlistDialog
              branchId={branchId}
              trigger={<Button variant="outline">Add to waiting list</Button>}
            />
          )}
          {canCreate && (
            <ReservationDialog
              branchId={branchId}
              defaultDate={date}
              trigger={<Button>New booking</Button>}
            />
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Bookings today</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {upcoming.length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Covers</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{covers}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Waiting now</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {waitlist.length}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {waitlist.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Waiting list</CardTitle>
            <CardDescription>
              In arrival order. Position is worked out from when people
              joined, never stored.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {waitlist.map((entry) => (
                <WaitlistRow
                  key={entry.id}
                  entry={entry}
                  tables={tables
                    .filter((t) => t.capacity >= entry.partySize)
                    .map((t) => ({ id: t.id, code: t.code }))}
                  canManage={canManageWaitlist}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {upcoming.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Nothing booked.
            </p>
          ) : (
            <ul className="divide-y">
              {upcoming.map((reservation) => (
                <ReservationRow
                  key={reservation.id}
                  reservation={reservation}
                  canSeat={canSeat}
                  canCancel={canCancel}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {settled.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Earlier today</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {settled.map((reservation) => (
                <li
                  key={reservation.id}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-xs tabular-nums">
                      {reservation.startsAt.toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="truncate">{reservation.guestName}</span>
                    <span className="text-muted-foreground">
                      ×{reservation.partySize}
                    </span>
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {reservation.status.replace('_', ' ')}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
