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
import { formatMinutes, shiftMinutes } from '@/modules/workforce/timesheet'
import { ClockButton } from '@/modules/workforce/ui/clock-button'
import { PublishRosterButton } from '@/modules/workforce/ui/publish-roster-button'
import { ShiftDialog } from '@/modules/workforce/ui/shift-dialog'
import {
  listOnShift,
  listRosterableStaff,
  listShifts,
  readOpenPunch,
  readTimesheet,
} from '@/modules/workforce/workforce.service'

export const metadata: Metadata = { title: 'Roster' }

/** Monday of the week containing `date`. */
function weekStart(date: Date): Date {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  // getDay() is 0 for Sunday, which is the end of the week here, not the start.
  const offset = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - offset)
  return start
}

const DAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default async function RosterPage({
  searchParams,
}: PageProps<'/roster'>) {
  const ctx = await requirePermission('shift.view')
  const { restaurantId } = ctx.tenant

  const branches = await listBranches(restaurantId, ctx.user.id)

  if (branches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          Shifts are rostered per branch. Create a branch first.
        </p>
      </div>
    )
  }

  const params = await searchParams
  const requested = typeof params.branch === 'string' ? params.branch : null
  const branchId =
    branches.find((branch) => branch.id === requested)?.id ?? branches[0].id

  const from =
    typeof params.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.week)
      ? weekStart(new Date(`${params.week}T00:00:00`))
      : weekStart(new Date())

  const to = new Date(from)
  to.setDate(to.getDate() + 7)

  const canManage = ctx.tenant.permissions.has('shift.manage')
  const canPublish = ctx.tenant.permissions.has('shift.publish')
  const canSeeTimesheet = ctx.tenant.permissions.has('attendance.view')
  const canClock = ctx.tenant.permissions.has('attendance.clock')

  const [shifts, staff, onShift, openPunch, timesheet] = await Promise.all([
    listShifts(restaurantId, ctx.user.id, branchId, from, to),
    canManage
      ? listRosterableStaff(restaurantId, ctx.user.id)
      : Promise.resolve([]),
    canSeeTimesheet
      ? listOnShift(restaurantId, ctx.user.id, branchId)
      : Promise.resolve([]),
    canClock ? readOpenPunch(restaurantId, ctx.user.id) : Promise.resolve(null),
    canSeeTimesheet
      ? readTimesheet(restaurantId, ctx.user.id, branchId, from, to)
      : Promise.resolve([]),
  ])

  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(from)
    day.setDate(day.getDate() + index)
    return day
  })

  const unpublished = shifts.filter((shift) => shift.publishedAt === null)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Roster</h1>
          <p className="text-sm text-muted-foreground">
            Week of{' '}
            {from.toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'long',
            })}
            . Staff see published shifts only.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <BranchSwitcher branches={branches} value={branchId} />
          {canClock && (
            <ClockButton branchId={branchId} openPunch={openPunch} />
          )}
          {canPublish && unpublished.length > 0 && (
            <PublishRosterButton
              branchId={branchId}
              from={from.toISOString()}
              to={to.toISOString()}
              count={unpublished.length}
            />
          )}
          {canManage && staff.length > 0 && (
            <ShiftDialog
              branchId={branchId}
              staff={staff}
              weekStart={from.toISOString().slice(0, 10)}
              trigger={<Button>Add shift</Button>}
            />
          )}
        </div>
      </div>

      {onShift.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">On shift now</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {onShift.map((person) => (
                <Badge key={person.userId} variant="secondary">
                  {person.userName} · since{' '}
                  {person.clockInAt.toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-7">
        {days.map((day, index) => {
          const dayShifts = shifts.filter(
            (shift) => shift.startsAt.toDateString() === day.toDateString(),
          )

          return (
            <Card key={day.toISOString()} className="min-h-32">
              <CardHeader className="pb-2">
                <CardDescription className="text-[11px] uppercase tracking-wide">
                  {DAY_LABEL[index]} {day.getDate()}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 px-3 pb-3">
                {dayShifts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">—</p>
                ) : (
                  dayShifts.map((shift) => (
                    <div
                      key={shift.id}
                      className={`rounded-md border px-2 py-1.5 text-xs ${
                        shift.publishedAt === null
                          ? 'border-dashed text-muted-foreground'
                          : ''
                      }`}
                    >
                      <div className="truncate font-medium">
                        {shift.userName}
                      </div>
                      <div className="font-mono tabular-nums">
                        {shift.startsAt.toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        –
                        {shift.endsAt.toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                      {shift.position && (
                        <div className="truncate text-[10px] text-muted-foreground">
                          {shift.position}
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground">
                        {formatMinutes(shiftMinutes(shift))}
                        {shift.publishedAt === null && ' · draft'}
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {canSeeTimesheet && timesheet.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Timesheet</CardTitle>
            <CardDescription>
              Hours worked this week. An open punch counts as zero until it is
              closed.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {timesheet.map((row) => (
                <li
                  key={row.userId}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{row.userName}</span>
                    {row.lateCount > 0 && (
                      <Badge variant="outline" className="text-[10px]">
                        {row.lateCount} late
                      </Badge>
                    )}
                    {row.punches.some((punch) => punch.wasEdited) && (
                      <Badge variant="secondary" className="text-[10px]">
                        edited
                      </Badge>
                    )}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">
                    {formatMinutes(row.totalMinutes)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
