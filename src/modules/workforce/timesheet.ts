/**
 * Timesheet arithmetic. Pure — no database, no clock, no I/O.
 *
 * Minutes throughout, as integers. Payroll runs on minutes, and a decimal
 * hours field is a rounding argument waiting to happen.
 */

export const MINUTE_MS = 60_000

/** How late someone may clock in before it counts as late. */
export const DEFAULT_GRACE_MINUTES = 5

export interface Punch {
  clockInAt: Date
  clockOutAt: Date | null
  breakMinutes: number
}

/**
 * Minutes actually worked on a punch.
 *
 * An open punch — clocked in, not yet out — returns zero rather than counting
 * up to the present. A timesheet that grows while you read it cannot be
 * checked, and someone who forgot to clock out three days ago would otherwise
 * show four thousand minutes of work.
 */
export function workedMinutes(punch: Punch): number {
  if (!punch.clockOutAt) return 0

  const gross = Math.round(
    (punch.clockOutAt.getTime() - punch.clockInAt.getTime()) / MINUTE_MS,
  )

  // Floored at zero: a clock-out before the clock-in is a data error, and
  // negative worked time would silently reduce someone's pay.
  return Math.max(0, gross - Math.max(0, punch.breakMinutes))
}

export function totalWorkedMinutes(punches: Punch[]): number {
  return punches.reduce((sum, punch) => sum + workedMinutes(punch), 0)
}

/** "7h 30m", "45m", "0m". */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  if (hours === 0) return `${rest}m`
  if (rest === 0) return `${hours}h`
  return `${hours}h ${rest}m`
}

/**
 * Minutes late against a rostered start, after the grace period.
 *
 * Zero when on time or early. Early arrival is deliberately not recorded as
 * negative lateness — turning up twenty minutes early is not twenty minutes
 * of credit against a later day, and treating it as such is how a lateness
 * figure stops meaning anything.
 */
export function latenessMinutes(
  shiftStartsAt: Date,
  clockInAt: Date,
  graceMinutes = DEFAULT_GRACE_MINUTES,
): number {
  const late = Math.round(
    (clockInAt.getTime() - shiftStartsAt.getTime()) / MINUTE_MS,
  )

  return late > graceMinutes ? late : 0
}

export interface Shift {
  id: string
  userId: string
  startsAt: Date
  endsAt: Date
}

/**
 * The shift a clock-in belongs to.
 *
 * Matches the shift whose start is nearest the punch, within a window either
 * side. Someone rostered 09:00–17:00 who clocks in at 08:52 is starting that
 * shift, not floating unattached; someone clocking in at 14:00 with shifts at
 * 09:00 and 17:00 belongs to neither and is doing something the roster did
 * not anticipate.
 *
 * Returning null is a real answer, not a failure. Unrostered work happens —
 * covering a sick colleague, coming in on a day off — and the honest record
 * is a punch with no shift rather than one forced onto the nearest.
 */
export function matchShift(
  shifts: Shift[],
  userId: string,
  clockInAt: Date,
  windowMinutes = 120,
): Shift | null {
  const candidates = shifts
    .filter((shift) => shift.userId === userId)
    .map((shift) => ({
      shift,
      distance: Math.abs(
        (clockInAt.getTime() - shift.startsAt.getTime()) / MINUTE_MS,
      ),
    }))
    .filter((c) => c.distance <= windowMinutes)
    .sort((a, b) => a.distance - b.distance)

  return candidates[0]?.shift ?? null
}

export function shiftMinutes(shift: { startsAt: Date; endsAt: Date }): number {
  return Math.max(
    0,
    Math.round((shift.endsAt.getTime() - shift.startsAt.getTime()) / MINUTE_MS),
  )
}

export interface RosterConflict {
  userId: string
  firstShiftId: string
  secondShiftId: string
}

/**
 * Shifts that put the same person in two places at once.
 *
 * Checked when publishing rather than when saving, so a manager can build a
 * roster in any order and rearrange freely. Blocking each individual save
 * would make moving one shift past another impossible without deleting it.
 */
export function findRosterConflicts(shifts: Shift[]): RosterConflict[] {
  const byUser = new Map<string, Shift[]>()

  for (const shift of shifts) {
    const list = byUser.get(shift.userId) ?? []
    list.push(shift)
    byUser.set(shift.userId, list)
  }

  const conflicts: RosterConflict[] = []

  for (const [userId, list] of byUser) {
    const sorted = [...list].sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
    )

    for (let i = 1; i < sorted.length; i += 1) {
      // Touching shifts do not conflict: finishing at 17:00 and starting at
      // 17:00 is a double, which is gruelling but not impossible.
      if (sorted[i].startsAt < sorted[i - 1].endsAt) {
        conflicts.push({
          userId,
          firstShiftId: sorted[i - 1].id,
          secondShiftId: sorted[i].id,
        })
      }
    }
  }

  return conflicts
}
