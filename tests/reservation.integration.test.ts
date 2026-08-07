import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import {
  branches,
  diningSessions,
  restaurants,
  users,
} from '@/lib/db/schema'
import { ConflictError } from '@/lib/errors'
import {
  findOrCreateCustomer,
  readCustomer,
} from '@/modules/promotion/loyalty.service'
import { createItem } from '@/modules/menu/item.service'
import {
  settleAndCloseSession,
  takePayment,
} from '@/modules/payment/payment.service'
import { placeStaffOrder } from '@/modules/pos/pos.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import {
  attachCustomerToSession,
  readCustomerProfile,
} from '@/modules/crm/customer.service'
import {
  cancelReservation,
  checkAvailability,
  createReservation,
  joinWaitlist,
  listReservations,
  listWaitlist,
  rescheduleReservation,
  seatFromWaitlist,
  seatReservation,
  updateWaitlistStatus,
} from '@/modules/reservation/reservation.service'
import { updateSettings } from '@/modules/settings/settings.service'
import { createTable } from '@/modules/table/table.service'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'

/**
 * Reservations, the waiting list, and loyalty accrual, against a real
 * database.
 *
 * The booking arithmetic is unit-tested in booking.test.ts. What needs a
 * database is that the last table cannot be double-booked, that seating opens
 * a real bill, that the waiting list stays in arrival order — and, closing the
 * gap Phase 9 left open, that settling a bill with a member attached actually
 * awards them points.
 *
 *   npm run db:migrate && npm run db:seed
 *   $env:RUN_DB_TESTS=1; npm test
 */

const enabled = process.env.RUN_DB_TESTS === '1'

const ITEM_BASE = {
  status: 'active' as const,
  isFeatured: false,
  isRecommended: false,
  displayOrder: 0,
  tagIds: [],
  unavailableBranchIds: [],
  availability: [],
  attributes: {},
}

describe.skipIf(!enabled)('reservations, waitlist and loyalty accrual', () => {
  let restaurantId: string
  let ownerId: string
  let branchId: string
  let itemId: string

  const ctx = () => ({ restaurantId, userId: ownerId })

  /** Tomorrow at the given hour, well clear of "in the past". */
  function tomorrowAt(hour: number, minute = 0): Date {
    const when = new Date()
    when.setDate(when.getDate() + 1)
    when.setHours(hour, minute, 0, 0)
    return when
  }

  /**
   * Through the real service, not a raw insert — a table needs a QR token,
   * and a test that hand-rolls the row would drift from what the application
   * actually creates.
   */
  async function makeTable(code: string, capacity: number): Promise<string> {
    const { id } = await createTable(ctx(), branchId, { code, capacity })
    return id
  }

  /**
   * Starts each test on a fresh, empty branch.
   *
   * Deleting the previous branch's tables is not an option, and should not
   * be: a table referenced by a session is `ON DELETE restrict`, so a table
   * with history cannot vanish and take the bills that happened on it. That
   * constraint is right, so the test works with it rather than around it.
   */
  async function freshBranch(): Promise<void> {
    const [branch] = await withTenant(ctx(), (tx) =>
      tx
        .insert(branches)
        .values({
          restaurantId,
          name: `B ${randomUUID().slice(0, 6)}`,
          code: randomUUID().slice(0, 6).toUpperCase(),
        })
        .returning({ id: branches.id }),
    )
    branchId = branch.id
  }

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `res-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `Res ${s}`))
    ).restaurantId

    const [branch] = await withTenant(ctx(), (tx) =>
      tx
        .insert(branches)
        .values({ restaurantId, name: 'Main', code: 'M1' })
        .returning({ id: branches.id }),
    )
    branchId = branch.id

    itemId = (
      await createItem(ctx(), { ...ITEM_BASE, name: 'Item', price: 1000 })
    ).id

    // No tax or service charge, so RM 10.00 ordered is RM 10.00 paid.
    await updateSettings(ctx(), {
      name: `Res ${s}`,
      currency: 'MYR',
      timezone: 'Asia/Kuala_Lumpur',
      locale: 'en',
      taxRatePercent: 0,
      serviceChargePercent: 0,
      taxInclusive: false,
      businessDayStartMinutes: 0,
    })
  })

  afterAll(async () => {
    await withTenant(ctx(), (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, restaurantId)),
    )
    await db.delete(users).where(eq(users.id, ownerId))
  })

  describe('taking a booking', () => {
    it('assigns the smallest table that fits', async () => {
      await freshBranch()
      await makeTable('T2', 2)
      const four = await makeTable('T4', 4)
      await makeTable('T8', 8)

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Ana',
        partySize: 4,
        startsAt: tomorrowAt(19),
      })

      // Seating a four on the eight-top is how a restaurant runs out of
      // capacity at 60% occupancy.
      expect(booking.tableId).toBe(four)
    })

    it('refuses the last table to a second booking at the same time', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      await createReservation(ctx(), {
        branchId,
        guestName: 'First',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      /**
       * The whole failure mode: two people on two phones, both told a table
       * is free a moment before one of them takes it. The check inside the
       * transaction is what makes the second lose.
       */
      await expect(
        createReservation(ctx(), {
          branchId,
          guestName: 'Second',
          partySize: 2,
          startsAt: tomorrowAt(19, 30),
        }),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('allows a booking that starts as the previous turn ends', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      await createReservation(ctx(), {
        branchId,
        guestName: 'First',
        partySize: 2,
        startsAt: tomorrowAt(18),
        turnMinutes: 90,
      })

      // 18:00 + 90 minutes frees the table at 19:30 exactly.
      await expect(
        createReservation(ctx(), {
          branchId,
          guestName: 'Second',
          partySize: 2,
          startsAt: tomorrowAt(19, 30),
          turnMinutes: 90,
        }),
      ).resolves.toBeTruthy()
    })

    it('refuses a party larger than any table', async () => {
      await freshBranch()
      await makeTable('T4', 4)

      await expect(
        createReservation(ctx(), {
          branchId,
          guestName: 'Big party',
          partySize: 12,
          startsAt: tomorrowAt(19),
        }),
      ).rejects.toThrow(/largest table seats 4/i)
    })

    it('refuses a booking in the past', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      await expect(
        createReservation(ctx(), {
          branchId,
          guestName: 'Time traveller',
          partySize: 2,
          startsAt: new Date(Date.now() - 60_000),
        }),
      ).rejects.toThrow(/already passed/i)
    })
  })

  describe('availability', () => {
    it('offers alternative times when a slot is taken', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      await createReservation(ctx(), {
        branchId,
        guestName: 'Holder',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      const result = await checkAvailability(
        restaurantId,
        ownerId,
        branchId,
        tomorrowAt(19),
        2,
      )

      expect(result.available).toBe(false)
      expect(result.alternatives.length).toBeGreaterThan(0)
    })

    it('offers no alternatives when the party can never be seated', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      const result = await checkAvailability(
        restaurantId,
        ownerId,
        branchId,
        tomorrowAt(19),
        20,
      )

      // Suggesting four other times for a party that will never fit is a
      // worse answer than none.
      expect(result.alternatives).toEqual([])
      expect(result.message).toMatch(/largest table/i)
    })
  })

  describe('rescheduling', () => {
    it('lets a booking be nudged without clashing with itself', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Ana',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      // Without excluding itself from the clash check, no booking could ever
      // be moved by less than a full turn.
      await expect(
        rescheduleReservation(ctx(), booking.id, {
          startsAt: tomorrowAt(19, 15),
        }),
      ).resolves.toBeUndefined()
    })

    it('refuses to reschedule a party that is already seated', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Ana',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      await seatReservation(ctx(), booking.id)

      await expect(
        rescheduleReservation(ctx(), booking.id, {
          startsAt: tomorrowAt(20),
        }),
      ).rejects.toBeInstanceOf(ConflictError)
    })
  })

  describe('seating', () => {
    it('opens a real bill on the booked table', async () => {
      await freshBranch()
      const tableId = await makeTable('T2', 2)

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Ana',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      const { sessionId } = await seatReservation(ctx(), booking.id)

      const [session] = await withTenant(ctx(), (tx) =>
        tx
          .select({
            tableId: diningSessions.tableId,
            status: diningSessions.status,
            guestCount: diningSessions.guestCount,
          })
          .from(diningSessions)
          .where(eq(diningSessions.id, sessionId)),
      )

      expect(session.tableId).toBe(tableId)
      expect(session.status).toBe('open')
      expect(session.guestCount).toBe(2)
    })

    it('refuses to seat the same booking twice', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Ana',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      await seatReservation(ctx(), booking.id)

      await expect(
        seatReservation(ctx(), booking.id),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('carries a member from the booking onto the bill', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      const { id: customerId } = await findOrCreateCustomer(ctx(), {
        name: 'Regular',
        phone: `+601${randomUUID().slice(0, 8)}`,
      })

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Regular',
        customerId,
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      const { sessionId } = await seatReservation(ctx(), booking.id)

      const [session] = await withTenant(ctx(), (tx) =>
        tx
          .select({ customerId: diningSessions.customerId })
          .from(diningSessions)
          .where(eq(diningSessions.id, sessionId)),
      )

      // A regular who books under their membership should not be asked again
      // at the till.
      expect(session.customerId).toBe(customerId)
    })

    it('refuses to mark a seated party a no-show', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Ana',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      await seatReservation(ctx(), booking.id)

      await expect(
        cancelReservation(ctx(), booking.id, 'no_show'),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('frees the slot when a booking is cancelled', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      const first = await createReservation(ctx(), {
        branchId,
        guestName: 'First',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      await cancelReservation(ctx(), first.id, 'cancelled', 'Changed plans')

      // A cancelled booking must not keep blocking the table it released.
      await expect(
        createReservation(ctx(), {
          branchId,
          guestName: 'Second',
          partySize: 2,
          startsAt: tomorrowAt(19),
        }),
      ).resolves.toBeTruthy()
    })
  })

  describe('the waiting list', () => {
    async function clearWaitlist(): Promise<void> {
      const entries = await listWaitlist(restaurantId, ownerId, branchId)
      for (const entry of entries) {
        await updateWaitlistStatus(ctx(), entry.id, 'left')
      }
    }

    it('numbers parties by arrival', async () => {
      await freshBranch()
      await makeTable('T4', 4)
      await clearWaitlist()

      await joinWaitlist(ctx(), {
        branchId,
        guestName: 'First',
        partySize: 2,
      })
      await joinWaitlist(ctx(), {
        branchId,
        guestName: 'Second',
        partySize: 2,
      })

      const list = await listWaitlist(restaurantId, ownerId, branchId)

      expect(list.map((e) => e.guestName)).toEqual(['First', 'Second'])
      expect(list.map((e) => e.position)).toEqual([1, 2])
    })

    it('renumbers automatically when someone leaves', async () => {
      await freshBranch()
      await makeTable('T4', 4)
      await clearWaitlist()

      const first = await joinWaitlist(ctx(), {
        branchId,
        guestName: 'First',
        partySize: 2,
      })
      await joinWaitlist(ctx(), {
        branchId,
        guestName: 'Second',
        partySize: 2,
      })

      await updateWaitlistStatus(ctx(), first.id, 'left')

      const list = await listWaitlist(restaurantId, ownerId, branchId)

      /**
       * Position is derived from arrival order, never stored. A stored
       * position has to be renumbered on every departure, and the one time
       * that is missed the queue silently reorders itself.
       */
      expect(list).toHaveLength(1)
      expect(list[0].guestName).toBe('Second')
      expect(list[0].position).toBe(1)
    })

    it('refuses a party larger than any table', async () => {
      await freshBranch()
      await makeTable('T4', 4)

      await expect(
        joinWaitlist(ctx(), {
          branchId,
          guestName: 'Big party',
          partySize: 12,
        }),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('seats from the list onto a real bill', async () => {
      await freshBranch()
      const tableId = await makeTable('T4', 4)
      await clearWaitlist()

      const entry = await joinWaitlist(ctx(), {
        branchId,
        guestName: 'Ana',
        partySize: 2,
      })

      const { sessionId } = await seatFromWaitlist(ctx(), entry.id, tableId)

      const [session] = await withTenant(ctx(), (tx) =>
        tx
          .select({ tableId: diningSessions.tableId })
          .from(diningSessions)
          .where(eq(diningSessions.id, sessionId)),
      )

      expect(session.tableId).toBe(tableId)
      expect(
        await listWaitlist(restaurantId, ownerId, branchId),
      ).toHaveLength(0)
    })

    it('refuses to seat a party that already left', async () => {
      await freshBranch()
      const tableId = await makeTable('T4', 4)
      await clearWaitlist()

      const entry = await joinWaitlist(ctx(), {
        branchId,
        guestName: 'Ana',
        partySize: 2,
      })

      await updateWaitlistStatus(ctx(), entry.id, 'left')

      await expect(
        seatFromWaitlist(ctx(), entry.id, tableId),
      ).rejects.toBeInstanceOf(ConflictError)
    })
  })

  describe('loyalty accrual at settlement', () => {
    it('awards points to the member attached to the bill', async () => {
      await freshBranch()
      const tableId = await makeTable('T2', 2)

      const { id: customerId } = await findOrCreateCustomer(ctx(), {
        name: 'Ben',
        phone: `+601${randomUUID().slice(0, 8)}`,
      })

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Ben',
        customerId,
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      const { sessionId } = await seatReservation(ctx(), booking.id)
      void tableId

      await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: itemId, quantity: 3, modifierSelections: [] }],
      })

      await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 3000,
        tendered: 3000,
        idempotencyKey: randomUUID(),
      })

      const before = await readCustomer(restaurantId, ownerId, customerId)
      expect(before.pointsBalance).toBe(0)

      await settleAndCloseSession(ctx(), sessionId)

      /**
       * The Phase 9 gap, closed. The accrual was written, tested and
       * idempotent from Phase 9, but a bill had no customer to award points
       * to until Phase 11 added the link. RM 30.00 at one point per major
       * unit is 30 points.
       */
      const after = await readCustomer(restaurantId, ownerId, customerId)
      expect(after.pointsBalance).toBe(30)
    })

    it('awards nothing when no member is attached', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Walk-in',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      const { sessionId } = await seatReservation(ctx(), booking.id)

      await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: itemId, quantity: 1, modifierSelections: [] }],
      })
      await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey: randomUUID(),
      })

      // Settling an anonymous bill must not fail looking for a member.
      await expect(
        settleAndCloseSession(ctx(), sessionId),
      ).resolves.toBeUndefined()
    })

    it('refuses to attach a member to a bill that is already closed', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      const { id: customerId } = await findOrCreateCustomer(ctx(), {
        name: 'Late',
        phone: `+601${randomUUID().slice(0, 8)}`,
      })

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Late',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      const { sessionId } = await seatReservation(ctx(), booking.id)
      await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: itemId, quantity: 1, modifierSelections: [] }],
      })
      await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey: randomUUID(),
      })
      await settleAndCloseSession(ctx(), sessionId)

      /**
       * Attaching after the fact would mean either awarding points for a
       * visit already reconciled, or quietly awarding none. Both are worse
       * than saying no.
       */
      await expect(
        attachCustomerToSession(ctx(), sessionId, customerId),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('counts the visit and the spend on the profile', async () => {
      await freshBranch()
      await makeTable('T2', 2)

      const { id: customerId } = await findOrCreateCustomer(ctx(), {
        name: 'Cara',
        phone: `+601${randomUUID().slice(0, 8)}`,
      })

      const booking = await createReservation(ctx(), {
        branchId,
        guestName: 'Cara',
        customerId,
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      const { sessionId } = await seatReservation(ctx(), booking.id)
      await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: itemId, quantity: 2, modifierSelections: [] }],
      })
      await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 2000,
        tendered: 2000,
        idempotencyKey: randomUUID(),
      })
      await settleAndCloseSession(ctx(), sessionId)

      const profile = await readCustomerProfile(
        restaurantId,
        ownerId,
        customerId,
      )

      expect(profile.visitCount).toBe(1)
      // Summed from captured payments, not bill totals — a comped or unpaid
      // bill is not money the customer spent.
      expect(profile.totalSpendMinor).toBe(2000)
      expect(profile.averageSpendMinor).toBe(2000)
      expect(profile.pointsBalance).toBe(20)
    })
  })

  describe('listing', () => {
    it('returns only bookings for the day asked for', async () => {
      await freshBranch()
      await makeTable('T2', 2)
      await makeTable('T4', 4)

      await createReservation(ctx(), {
        branchId,
        guestName: 'Tomorrow',
        partySize: 2,
        startsAt: tomorrowAt(19),
      })

      const from = tomorrowAt(0)
      const to = new Date(from)
      to.setDate(to.getDate() + 1)

      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const todayEnd = new Date(today)
      todayEnd.setDate(todayEnd.getDate() + 1)

      const tomorrowList = await listReservations(
        restaurantId,
        ownerId,
        branchId,
        from,
        to,
      )
      const todayList = await listReservations(
        restaurantId,
        ownerId,
        branchId,
        today,
        todayEnd,
      )

      expect(tomorrowList.some((r) => r.guestName === 'Tomorrow')).toBe(true)
      expect(todayList.some((r) => r.guestName === 'Tomorrow')).toBe(false)
    })
  })
})
