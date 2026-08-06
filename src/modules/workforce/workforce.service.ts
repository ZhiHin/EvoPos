import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import {
  attendanceRecords,
  memberships,
  shifts,
  users,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import {
  findRosterConflicts,
  latenessMinutes,
  matchShift,
  totalWorkedMinutes,
  workedMinutes,
  type Shift,
} from './timesheet'

/**
 * The roster and the time clock.
 *
 * The arithmetic lives in `timesheet.ts`; this module supplies the shifts and
 * punches and persists the results.
 */

export interface ShiftRow {
  id: string
  userId: string
  userName: string
  startsAt: Date
  endsAt: Date
  position: string | null
  notes: string | null
  publishedAt: Date | null
}

export async function listShifts(
  restaurantId: string,
  userId: string,
  branchId: string,
  from: Date,
  to: Date,
): Promise<ShiftRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: shifts.id,
        userId: shifts.userId,
        userName: users.name,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
        position: shifts.position,
        notes: shifts.notes,
        publishedAt: shifts.publishedAt,
      })
      .from(shifts)
      .innerJoin(users, eq(users.id, shifts.userId))
      .where(
        and(
          eq(shifts.restaurantId, restaurantId),
          eq(shifts.branchId, branchId),
          gte(shifts.startsAt, from),
          lt(shifts.startsAt, to),
        ),
      )
      .orderBy(asc(shifts.startsAt), asc(users.name)),
  )
}

/**
 * The roster as a staff member sees it: their own shifts, published only.
 *
 * A separate read rather than a filter on the manager's list, because the two
 * answer different questions and a forgotten `publishedAt` check on a shared
 * one would leak next week's draft to everybody in it.
 */
export async function listMyShifts(
  restaurantId: string,
  userId: string,
  from: Date,
  to: Date,
): Promise<ShiftRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: shifts.id,
        userId: shifts.userId,
        userName: users.name,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
        position: shifts.position,
        notes: shifts.notes,
        publishedAt: shifts.publishedAt,
      })
      .from(shifts)
      .innerJoin(users, eq(users.id, shifts.userId))
      .where(
        and(
          eq(shifts.restaurantId, restaurantId),
          eq(shifts.userId, userId),
          sql`${shifts.publishedAt} is not null`,
          gte(shifts.startsAt, from),
          lt(shifts.startsAt, to),
        ),
      )
      .orderBy(asc(shifts.startsAt)),
  )
}

export async function createShift(
  ctx: BranchActorContext,
  input: {
    branchId: string
    userId: string
    startsAt: Date
    endsAt: Date
    position?: string | null
    notes?: string | null
  },
): Promise<{ id: string }> {
  if (input.endsAt <= input.startsAt) {
    throw new ValidationError('A shift has to end after it starts.', {
      endsAt: ['A shift has to end after it starts.'],
    })
  }

  return withTenant(ctx, async (tx) => {
    const [member] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.restaurantId, ctx.restaurantId),
          eq(memberships.userId, input.userId),
        ),
      )
      .limit(1)

    // Rostering someone who does not work here would produce a shift nobody
    // can see and nobody can clock into.
    if (!member) {
      throw new NotFoundError('That person is not a member of this restaurant.')
    }

    const [created] = await tx
      .insert(shifts)
      .values({
        restaurantId: ctx.restaurantId,
        branchId: input.branchId,
        userId: input.userId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        position: input.position ?? null,
        notes: input.notes ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: shifts.id })

    return { id: created.id }
  })
}

export async function deleteShift(
  ctx: BranchActorContext,
  shiftId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ publishedAt: shifts.publishedAt })
      .from(shifts)
      .where(
        and(
          eq(shifts.id, shiftId),
          eq(shifts.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Shift not found.')

    await tx.delete(shifts).where(eq(shifts.id, shiftId))

    if (existing.publishedAt) {
      // Deleting a published shift is a change to something someone has
      // already planned their week around, so it is worth a record.
      await recordAuditIn(tx, {
        restaurantId: ctx.restaurantId,
        actorUserId: ctx.userId,
        action: 'shift.deleted',
        entityType: 'shift',
        entityId: shiftId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      })
    }
  })
}

export interface PublishResult {
  published: number
  conflicts: { userId: string; userName: string }[]
}

/**
 * Publishes a week's roster.
 *
 * Conflicts are checked here rather than on each save, so a manager can build
 * a roster in any order and rearrange freely — blocking individual saves would
 * make moving one shift past another impossible without deleting it first.
 *
 * A conflict stops the publish outright. A roster that puts someone in two
 * places at once is not a draft to be published with a warning; it is wrong,
 * and the person it is wrong about will be the one who finds out.
 */
export async function publishRoster(
  ctx: BranchActorContext,
  branchId: string,
  from: Date,
  to: Date,
): Promise<PublishResult> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: shifts.id,
        userId: shifts.userId,
        userName: users.name,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
      })
      .from(shifts)
      .innerJoin(users, eq(users.id, shifts.userId))
      .where(
        and(
          eq(shifts.restaurantId, ctx.restaurantId),
          eq(shifts.branchId, branchId),
          gte(shifts.startsAt, from),
          lt(shifts.startsAt, to),
        ),
      )

    const conflicts = findRosterConflicts(
      rows.map(
        (row): Shift => ({
          id: row.id,
          userId: row.userId,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
        }),
      ),
    )

    if (conflicts.length > 0) {
      const nameById = new Map(rows.map((row) => [row.userId, row.userName]))

      return {
        published: 0,
        conflicts: [...new Set(conflicts.map((c) => c.userId))].map(
          (userId) => ({
            userId,
            userName: nameById.get(userId) ?? 'Unknown',
          }),
        ),
      }
    }

    const publishedAt = new Date()

    const published = await tx
      .update(shifts)
      .set({ publishedAt })
      .where(
        and(
          eq(shifts.restaurantId, ctx.restaurantId),
          eq(shifts.branchId, branchId),
          gte(shifts.startsAt, from),
          lt(shifts.startsAt, to),
          isNull(shifts.publishedAt),
        ),
      )
      .returning({ id: shifts.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'roster.published',
      entityType: 'branch',
      entityId: branchId,
      after: { from, to, count: published.length },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { published: published.length, conflicts: [] }
  })
}

// --- the time clock ---

export interface ClockInResult {
  id: string
  shiftId: string | null
  latenessMinutes: number
}

/**
 * Clocks the acting user in.
 *
 * Always the acting user, never a user id from the request. Clocking in on
 * someone else's behalf is buddy-punching, and the way to prevent it is to
 * make it unexpressible rather than to check a permission.
 */
export async function clockIn(
  ctx: BranchActorContext,
  branchId: string,
): Promise<ClockInResult> {
  return withTenant(ctx, async (tx) => {
    const [open] = await tx
      .select({ id: attendanceRecords.id })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.userId, ctx.userId),
          isNull(attendanceRecords.clockOutAt),
        ),
      )
      .limit(1)

    if (open) {
      throw new ConflictError('You are already clocked in.')
    }

    const now = new Date()
    const windowStart = new Date(now.getTime() - 12 * 60 * 60_000)
    const windowEnd = new Date(now.getTime() + 12 * 60 * 60_000)

    const candidates = await tx
      .select({
        id: shifts.id,
        userId: shifts.userId,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
      })
      .from(shifts)
      .where(
        and(
          eq(shifts.restaurantId, ctx.restaurantId),
          eq(shifts.userId, ctx.userId),
          gte(shifts.startsAt, windowStart),
          lt(shifts.startsAt, windowEnd),
        ),
      )

    const shift = matchShift(candidates, ctx.userId, now)

    /**
     * Snapshotted at the moment of clocking in. Recomputing it later would
     * let a manager move the rostered start and retroactively make someone
     * punctual — or late.
     */
    const lateness = shift ? latenessMinutes(shift.startsAt, now) : 0

    const [created] = await tx
      .insert(attendanceRecords)
      .values({
        restaurantId: ctx.restaurantId,
        branchId,
        userId: ctx.userId,
        shiftId: shift?.id ?? null,
        clockInAt: now,
        latenessMinutes: lateness,
      })
      .returning({ id: attendanceRecords.id })

    return {
      id: created.id,
      shiftId: shift?.id ?? null,
      latenessMinutes: lateness,
    }
  })
}

export async function clockOut(
  ctx: BranchActorContext,
  breakMinutes = 0,
): Promise<{ workedMinutes: number }> {
  if (breakMinutes < 0) {
    throw new ValidationError('A break cannot be negative.')
  }

  return withTenant(ctx, async (tx) => {
    const [open] = await tx
      .select({
        id: attendanceRecords.id,
        clockInAt: attendanceRecords.clockInAt,
      })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.userId, ctx.userId),
          isNull(attendanceRecords.clockOutAt),
        ),
      )
      .limit(1)

    if (!open) throw new ConflictError('You are not clocked in.')

    const now = new Date()

    await tx
      .update(attendanceRecords)
      .set({ clockOutAt: now, breakMinutes })
      .where(eq(attendanceRecords.id, open.id))

    return {
      workedMinutes: workedMinutes({
        clockInAt: open.clockInAt,
        clockOutAt: now,
        breakMinutes,
      }),
    }
  })
}

export async function readOpenPunch(
  restaurantId: string,
  userId: string,
): Promise<{ id: string; clockInAt: Date; shiftId: string | null } | null> {
  const [open] = await withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: attendanceRecords.id,
        clockInAt: attendanceRecords.clockInAt,
        shiftId: attendanceRecords.shiftId,
      })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.userId, userId),
          isNull(attendanceRecords.clockOutAt),
        ),
      )
      .limit(1),
  )

  return open ?? null
}

export interface TimesheetRow {
  userId: string
  userName: string
  punches: {
    id: string
    clockInAt: Date
    clockOutAt: Date | null
    breakMinutes: number
    latenessMinutes: number
    workedMinutes: number
    wasEdited: boolean
  }[]
  totalMinutes: number
  lateCount: number
}

export async function readTimesheet(
  restaurantId: string,
  userId: string,
  branchId: string,
  from: Date,
  to: Date,
): Promise<TimesheetRow[]> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const rows = await tx
      .select({
        id: attendanceRecords.id,
        userId: attendanceRecords.userId,
        userName: users.name,
        clockInAt: attendanceRecords.clockInAt,
        clockOutAt: attendanceRecords.clockOutAt,
        breakMinutes: attendanceRecords.breakMinutes,
        latenessMinutes: attendanceRecords.latenessMinutes,
        editedAt: attendanceRecords.editedAt,
      })
      .from(attendanceRecords)
      .innerJoin(users, eq(users.id, attendanceRecords.userId))
      .where(
        and(
          eq(attendanceRecords.restaurantId, restaurantId),
          eq(attendanceRecords.branchId, branchId),
          gte(attendanceRecords.clockInAt, from),
          lt(attendanceRecords.clockInAt, to),
        ),
      )
      .orderBy(asc(users.name), asc(attendanceRecords.clockInAt))

    const byUser = new Map<string, TimesheetRow>()

    for (const row of rows) {
      const entry = byUser.get(row.userId) ?? {
        userId: row.userId,
        userName: row.userName,
        punches: [],
        totalMinutes: 0,
        lateCount: 0,
      }

      entry.punches.push({
        id: row.id,
        clockInAt: row.clockInAt,
        clockOutAt: row.clockOutAt,
        breakMinutes: row.breakMinutes,
        latenessMinutes: row.latenessMinutes,
        workedMinutes: workedMinutes({
          clockInAt: row.clockInAt,
          clockOutAt: row.clockOutAt,
          breakMinutes: row.breakMinutes,
        }),
        wasEdited: row.editedAt !== null,
      })

      byUser.set(row.userId, entry)
    }

    for (const entry of byUser.values()) {
      entry.totalMinutes = totalWorkedMinutes(
        entry.punches.map((punch) => ({
          clockInAt: punch.clockInAt,
          clockOutAt: punch.clockOutAt,
          breakMinutes: punch.breakMinutes,
        })),
      )
      entry.lateCount = entry.punches.filter(
        (punch) => punch.latenessMinutes > 0,
      ).length
    }

    return [...byUser.values()]
  })
}

/**
 * Corrects a punch.
 *
 * Changes what someone is paid, so it records who did it, when, and why — and
 * the edit is visible on the timesheet afterwards. A correction nobody can
 * see is indistinguishable from the clock having been right all along.
 */
export async function editPunch(
  ctx: BranchActorContext,
  punchId: string,
  input: { clockInAt?: Date; clockOutAt?: Date | null; breakMinutes?: number },
  reason: string,
): Promise<void> {
  if (!reason.trim()) {
    throw new ValidationError('Give a reason for the correction.', {
      reason: ['Give a reason for the correction.'],
    })
  }

  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select()
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.id, punchId),
          eq(attendanceRecords.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Timesheet entry not found.')

    const clockInAt = input.clockInAt ?? existing.clockInAt
    const clockOutAt =
      input.clockOutAt === undefined ? existing.clockOutAt : input.clockOutAt

    if (clockOutAt && clockOutAt <= clockInAt) {
      throw new ValidationError('The clock-out has to be after the clock-in.')
    }

    await tx
      .update(attendanceRecords)
      .set({
        clockInAt,
        clockOutAt,
        breakMinutes: input.breakMinutes ?? existing.breakMinutes,
        editedByUserId: ctx.userId,
        editedAt: new Date(),
        editReason: reason,
      })
      .where(eq(attendanceRecords.id, punchId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'attendance.edited',
      entityType: 'attendance_record',
      entityId: punchId,
      before: {
        clockInAt: existing.clockInAt,
        clockOutAt: existing.clockOutAt,
        breakMinutes: existing.breakMinutes,
      },
      after: {
        clockInAt,
        clockOutAt,
        breakMinutes: input.breakMinutes ?? existing.breakMinutes,
        reason,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/** Who is currently clocked in at a branch. */
export async function listOnShift(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<{ userId: string; userName: string; clockInAt: Date }[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        userId: attendanceRecords.userId,
        userName: users.name,
        clockInAt: attendanceRecords.clockInAt,
      })
      .from(attendanceRecords)
      .innerJoin(users, eq(users.id, attendanceRecords.userId))
      .where(
        and(
          eq(attendanceRecords.restaurantId, restaurantId),
          eq(attendanceRecords.branchId, branchId),
          isNull(attendanceRecords.clockOutAt),
        ),
      )
      .orderBy(asc(attendanceRecords.clockInAt)),
  )
}

export async function listRosterableStaff(
  restaurantId: string,
  userId: string,
): Promise<{ id: string; name: string }[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({ id: users.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.restaurantId, restaurantId),
          inArray(memberships.status, ['active']),
        ),
      )
      .orderBy(asc(users.name)),
  )
}
