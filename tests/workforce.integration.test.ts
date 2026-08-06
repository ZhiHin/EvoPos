import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import { attendanceRecords, branches, restaurants, shifts, users } from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import {
  clockIn,
  clockOut,
  createShift,
  listMyShifts,
  listOnShift,
  listShifts,
  publishRoster,
  readOpenPunch,
  readTimesheet,
} from '@/modules/workforce/workforce.service'

/**
 * The roster and the time clock, against a real database.
 *
 * The arithmetic is unit-tested in timesheet.test.ts. What needs a database is
 * that a draft roster stays invisible to the people on it, that publishing
 * refuses a double-booked person, that a clock-in finds its shift, and that
 * the partial unique index really does stop two open punches.
 *
 *   npm run db:migrate && npm run db:seed
 *   $env:RUN_DB_TESTS=1; npm test
 */

const enabled = process.env.RUN_DB_TESTS === '1'

describe.skipIf(!enabled)('roster and attendance', () => {
  let restaurantId: string
  let ownerId: string
  let branchId: string

  const ctx = () => ({ restaurantId, userId: ownerId })

  /** Today at the given hour, so clock-ins land inside the match window. */
  function todayAt(hour: number, minute = 0): Date {
    const when = new Date()
    when.setHours(hour, minute, 0, 0)
    return when
  }

  function weekBounds(): { from: Date; to: Date } {
    const from = new Date()
    from.setHours(0, 0, 0, 0)
    from.setDate(from.getDate() - 3)
    const to = new Date(from)
    to.setDate(to.getDate() + 14)
    return { from, to }
  }

  async function clearShifts(): Promise<void> {
    await withTenant(ctx(), async (tx) => {
      await tx.delete(attendanceRecords).where(
        eq(attendanceRecords.restaurantId, restaurantId),
      )
      await tx.delete(shifts).where(eq(shifts.restaurantId, restaurantId))
    })
  }

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `wf-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `WF ${s}`))
    ).restaurantId

    const [branch] = await withTenant(ctx(), (tx) =>
      tx
        .insert(branches)
        .values({ restaurantId, name: 'Main', code: 'M1' })
        .returning({ id: branches.id }),
    )
    branchId = branch.id
  })

  afterAll(async () => {
    await withTenant(ctx(), (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, restaurantId)),
    )
    await db.delete(users).where(eq(users.id, ownerId))
  })

  describe('rostering', () => {
    it('refuses to roster someone who does not work here', async () => {
      const [stranger] = await db
        .insert(users)
        .values({
          email: `stranger-${randomUUID().slice(0, 8)}@test.local`,
          name: 'Stranger',
        })
        .returning({ id: users.id })

      // A shift nobody can see and nobody can clock into is worse than an
      // error, because it looks like coverage.
      await expect(
        createShift(ctx(), {
          branchId,
          userId: stranger.id,
          startsAt: todayAt(9),
          endsAt: todayAt(17),
        }),
      ).rejects.toBeInstanceOf(NotFoundError)

      await db.delete(users).where(eq(users.id, stranger.id))
    })

    it('refuses a shift that ends before it starts', async () => {
      await expect(
        createShift(ctx(), {
          branchId,
          userId: ownerId,
          startsAt: todayAt(17),
          endsAt: todayAt(9),
        }),
      ).rejects.toThrow(/end after it starts/i)
    })

    it('keeps a draft shift invisible to the person rostered', async () => {
      await clearShifts()
      const { from, to } = weekBounds()

      await createShift(ctx(), {
        branchId,
        userId: ownerId,
        startsAt: todayAt(9),
        endsAt: todayAt(17),
      })

      /**
       * A manager sees the draft; the person on it does not. Publishing is
       * what turns a roster into a commitment, and leaking a draft is how
       * someone plans a week around a shift that then moves.
       */
      expect(
        await listShifts(restaurantId, ownerId, branchId, from, to),
      ).toHaveLength(1)
      expect(await listMyShifts(restaurantId, ownerId, from, to)).toHaveLength(
        0,
      )
    })

    it('publishes a clean week and makes it visible', async () => {
      await clearShifts()
      const { from, to } = weekBounds()

      await createShift(ctx(), {
        branchId,
        userId: ownerId,
        startsAt: todayAt(9),
        endsAt: todayAt(17),
      })

      const result = await publishRoster(ctx(), branchId, from, to)

      expect(result.conflicts).toEqual([])
      expect(result.published).toBe(1)
      expect(await listMyShifts(restaurantId, ownerId, from, to)).toHaveLength(
        1,
      )
    })

    it('refuses to publish a person rostered in two places at once', async () => {
      await clearShifts()
      const { from, to } = weekBounds()

      await createShift(ctx(), {
        branchId,
        userId: ownerId,
        startsAt: todayAt(9),
        endsAt: todayAt(17),
      })
      await createShift(ctx(), {
        branchId,
        userId: ownerId,
        startsAt: todayAt(16),
        endsAt: todayAt(22),
      })

      const result = await publishRoster(ctx(), branchId, from, to)

      expect(result.published).toBe(0)
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0].userId).toBe(ownerId)

      // Nothing published, so nothing leaked to the person it is wrong about.
      expect(await listMyShifts(restaurantId, ownerId, from, to)).toHaveLength(
        0,
      )
    })

    it('publishes a back-to-back double', async () => {
      await clearShifts()
      const { from, to } = weekBounds()

      await createShift(ctx(), {
        branchId,
        userId: ownerId,
        startsAt: todayAt(9),
        endsAt: todayAt(17),
      })
      await createShift(ctx(), {
        branchId,
        userId: ownerId,
        startsAt: todayAt(17),
        endsAt: todayAt(23),
      })

      // Gruelling, but not impossible, and not the software's call to make.
      const result = await publishRoster(ctx(), branchId, from, to)
      expect(result.conflicts).toEqual([])
      expect(result.published).toBe(2)
    })
  })

  describe('the time clock', () => {
    it('matches a clock-in to the shift it starts, and records lateness', async () => {
      await clearShifts()

      const startsAt = new Date(Date.now() - 30 * 60_000)
      const endsAt = new Date(startsAt.getTime() + 8 * 60 * 60_000)

      const shift = await createShift(ctx(), {
        branchId,
        userId: ownerId,
        startsAt,
        endsAt,
      })

      const punch = await clockIn(ctx(), branchId)

      expect(punch.shiftId).toBe(shift.id)
      // Thirty minutes after the rostered start, well past the grace period.
      expect(punch.latenessMinutes).toBeGreaterThanOrEqual(29)

      await clockOut(ctx())
    })

    it('records no lateness for an unrostered punch', async () => {
      await clearShifts()

      const punch = await clockIn(ctx(), branchId)

      /**
       * Unrostered work is real — covering a sick colleague, coming in on a
       * day off. The honest record is a punch with no shift, not one forced
       * onto the nearest.
       */
      expect(punch.shiftId).toBeNull()
      expect(punch.latenessMinutes).toBe(0)

      await clockOut(ctx())
    })

    it('refuses a second clock-in while one is open', async () => {
      await clearShifts()
      await clockIn(ctx(), branchId)

      // A double-tap on the clock-in button must not open two punches, or
      // every subsequent clock-out closes an arbitrary one of them.
      await expect(clockIn(ctx(), branchId)).rejects.toBeInstanceOf(
        ConflictError,
      )

      await clockOut(ctx())
    })

    it('refuses a clock-out when nothing is open', async () => {
      await clearShifts()

      await expect(clockOut(ctx())).rejects.toBeInstanceOf(ConflictError)
    })

    it('reports who is on shift, and stops once they clock out', async () => {
      await clearShifts()
      await clockIn(ctx(), branchId)

      expect(await listOnShift(restaurantId, ownerId, branchId)).toHaveLength(1)
      expect(await readOpenPunch(restaurantId, ownerId)).not.toBeNull()

      await clockOut(ctx())

      expect(await listOnShift(restaurantId, ownerId, branchId)).toHaveLength(0)
      expect(await readOpenPunch(restaurantId, ownerId)).toBeNull()
    })

    it('counts worked minutes less the break', async () => {
      await clearShifts()

      await withTenant(ctx(), (tx) =>
        tx.insert(attendanceRecords).values({
          restaurantId,
          branchId,
          userId: ownerId,
          clockInAt: todayAt(9),
          clockOutAt: todayAt(17),
          breakMinutes: 30,
        }),
      )

      const { from, to } = weekBounds()
      const timesheet = await readTimesheet(
        restaurantId,
        ownerId,
        branchId,
        from,
        to,
      )

      expect(timesheet).toHaveLength(1)
      expect(timesheet[0].totalMinutes).toBe(450)
    })

    it('counts an open punch as zero rather than counting up', async () => {
      await clearShifts()
      await clockIn(ctx(), branchId)

      const { from, to } = weekBounds()
      const timesheet = await readTimesheet(
        restaurantId,
        ownerId,
        branchId,
        from,
        to,
      )

      /**
       * A timesheet that grows while it is read cannot be checked, and
       * someone who forgot to clock out three days ago would show four
       * thousand minutes of work.
       */
      expect(timesheet[0].totalMinutes).toBe(0)
      expect(timesheet[0].punches[0].clockOutAt).toBeNull()

      await clockOut(ctx())
    })
  })
})
