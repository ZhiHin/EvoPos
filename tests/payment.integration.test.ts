import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import { branches, payments, restaurants, users } from '@/lib/db/schema'
import { ConflictError, ValidationError } from '@/lib/errors'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { createItem } from '@/modules/menu/item.service'
import { updateSettings } from '@/modules/settings/settings.service'
import {
  openTakeawaySession,
  placeStaffOrder,
} from '@/modules/pos/pos.service'
import {
  issueRefund,
  readSettlement,
  readTakings,
  settleAndCloseSession,
  takePayment,
  voidPayment,
} from '@/modules/payment/payment.service'

/**
 * Payments against a real database.
 *
 * The settlement arithmetic is unit-tested in settlement.test.ts. What needs
 * a database is idempotency under real unique constraints, that refunds move
 * the balance, and that an unpaid bill cannot quietly close.
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

describe.skipIf(!enabled)('payments', () => {
  let restaurantId: string
  let ownerId: string
  let branchId: string
  let itemId: string

  const ctx = () => ({ restaurantId, userId: ownerId })
  const key = () => randomUUID()

  /** Opens a takeaway session with a single RM 10.00 item, no tax. */
  async function billFor(amountMinor = 1000) {
    const { sessionId } = await openTakeawaySession(ctx(), {
      type: 'takeaway',
      branchId,
    })

    await placeStaffOrder(ctx(), sessionId, {
      lines: [
        {
          menuItemId: itemId,
          quantity: amountMinor / 1000,
          modifierSelections: [],
        },
      ],
    })

    return sessionId
  }

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `pay-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `Pay ${s}`))
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

    // No tax or service charge, so the arithmetic in these tests is obvious.
    await updateSettings(ctx(), {
      name: `Pay ${s}`,
      currency: 'MYR',
      timezone: 'Asia/Kuala_Lumpur',
      locale: 'en',
      taxRatePercent: 0,
      serviceChargePercent: 0,
      taxInclusive: false,
    })
  })

  afterAll(async () => {
    await withTenant(ctx(), (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, restaurantId)),
    )
    await db.delete(users).where(eq(users.id, ownerId))
  })

  describe('taking payment', () => {
    it('settles a bill in full with cash', async () => {
      const sessionId = await billFor()

      const result = await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey: key(),
      })

      expect(result.settlement.isSettled).toBe(true)
      expect(result.changeMinor).toBe(0)
    })

    it('gives change and records only what was owed', async () => {
      const sessionId = await billFor()

      const result = await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 5000,
        idempotencyKey: key(),
      })

      // The drawer gains 10.00, not 50.00 — recording the tender would
      // overstate takings and leave the count short.
      expect(result.amountMinor).toBe(1000)
      expect(result.changeMinor).toBe(4000)
    })

    it('accepts mixed payment across two methods', async () => {
      const sessionId = await billFor()

      await takePayment(ctx(), sessionId, {
        method: 'card_terminal',
        amount: 600,
        idempotencyKey: key(),
      })

      const second = await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 400,
        tendered: 400,
        idempotencyKey: key(),
      })

      expect(second.settlement.isSettled).toBe(true)
      expect(second.settlement.paidMinor).toBe(1000)
    })

    /**
     * The single most important test in this phase. A double-clicked button
     * or a retry after a dropped connection must not take money twice.
     */
    it('is idempotent — the same key never charges twice', async () => {
      const sessionId = await billFor()
      const idempotencyKey = key()

      const first = await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey,
      })

      const replay = await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey,
      })

      expect(replay.wasReplay).toBe(true)
      expect(replay.paymentId).toBe(first.paymentId)

      const rows = await withTenant(ctx(), (tx) =>
        tx
          .select({ id: payments.id })
          .from(payments)
          .where(eq(payments.sessionId, sessionId)),
      )
      expect(rows).toHaveLength(1)
    })

    it('refuses a card payment larger than the balance', async () => {
      const sessionId = await billFor()

      // No way to hand back the difference on a card.
      await expect(
        takePayment(ctx(), sessionId, {
          method: 'card_terminal',
          amount: 1500,
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(ValidationError)
    })

    it('refuses payment on an already-settled bill', async () => {
      const sessionId = await billFor()

      await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey: key(),
      })

      await expect(
        takePayment(ctx(), sessionId, {
          method: 'cash',
          amount: 100,
          tendered: 100,
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(ConflictError)
    })
  })

  describe('voids and refunds', () => {
    it('voiding a payment restores the outstanding balance', async () => {
      const sessionId = await billFor()

      const paid = await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey: key(),
      })

      await voidPayment(ctx(), paid.paymentId, 'Rang up the wrong table')

      const settlement = await withTenant(ctx(), (tx) =>
        readSettlement(tx, restaurantId, sessionId),
      )

      expect(settlement.outstandingMinor).toBe(1000)
      expect(settlement.isSettled).toBe(false)
    })

    it('a partial refund reopens part of the balance', async () => {
      const sessionId = await billFor()

      const paid = await takePayment(ctx(), sessionId, {
        method: 'card_terminal',
        amount: 1000,
        idempotencyKey: key(),
      })

      await issueRefund(ctx(), paid.paymentId, {
        amount: 300,
        reason: 'Dish returned',
        idempotencyKey: key(),
      })

      const settlement = await withTenant(ctx(), (tx) =>
        readSettlement(tx, restaurantId, sessionId),
      )

      expect(settlement.paidMinor).toBe(700)
      expect(settlement.outstandingMinor).toBe(300)
    })

    it('refuses to refund more than was taken', async () => {
      const sessionId = await billFor()

      const paid = await takePayment(ctx(), sessionId, {
        method: 'card_terminal',
        amount: 1000,
        idempotencyKey: key(),
      })

      await expect(
        issueRefund(ctx(), paid.paymentId, {
          amount: 1500,
          reason: 'Too much',
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(ValidationError)
    })

    it('refunds are idempotent too', async () => {
      const sessionId = await billFor()
      const paid = await takePayment(ctx(), sessionId, {
        method: 'card_terminal',
        amount: 1000,
        idempotencyKey: key(),
      })

      const refundKey = key()
      const first = await issueRefund(ctx(), paid.paymentId, {
        amount: 200,
        reason: 'Once',
        idempotencyKey: refundKey,
      })
      const replay = await issueRefund(ctx(), paid.paymentId, {
        amount: 200,
        reason: 'Once',
        idempotencyKey: refundKey,
      })

      expect(replay.wasReplay).toBe(true)
      expect(replay.refundId).toBe(first.refundId)
    })

    /**
     * Voiding says the payment never happened; refunding says it did and the
     * money went back. A refunded payment is unambiguously the second, and
     * voiding it would leave a refund pointing at a payment that denies
     * existing.
     */
    it('refuses to void a payment that has been refunded', async () => {
      const sessionId = await billFor()
      const paid = await takePayment(ctx(), sessionId, {
        method: 'card_terminal',
        amount: 1000,
        idempotencyKey: key(),
      })

      await issueRefund(ctx(), paid.paymentId, {
        amount: 100,
        reason: 'Partial',
        idempotencyKey: key(),
      })

      await expect(
        voidPayment(ctx(), paid.paymentId, 'Trying to void'),
      ).rejects.toThrow(ConflictError)
    })
  })

  describe('closing', () => {
    /**
     * An unpaid bill quietly closing is how money goes missing — the table is
     * free, the screen is clear, and nobody can say where the forty ringgit
     * went.
     */
    it('refuses to close a bill with anything outstanding', async () => {
      const sessionId = await billFor()

      await expect(settleAndCloseSession(ctx(), sessionId)).rejects.toThrow(
        ConflictError,
      )
    })

    it('closes once the bill is settled', async () => {
      const sessionId = await billFor()

      await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey: key(),
      })

      await expect(
        settleAndCloseSession(ctx(), sessionId),
      ).resolves.toBeUndefined()
    })

    it('refuses payment on a closed bill', async () => {
      const sessionId = await billFor()
      await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey: key(),
      })
      await settleAndCloseSession(ctx(), sessionId)

      await expect(
        takePayment(ctx(), sessionId, {
          method: 'cash',
          amount: 100,
          tendered: 100,
          idempotencyKey: key(),
        }),
      ).rejects.toThrow(ConflictError)
    })
  })

  describe('reconciliation', () => {
    it('reports takings by method with refunds netted off', async () => {
      const from = new Date()
      from.setHours(0, 0, 0, 0)
      const to = new Date(from)
      to.setDate(to.getDate() + 1)

      const takings = await readTakings(restaurantId, ownerId, from, to)

      // Every test above ran today, so both methods appear.
      expect(takings.byMethod.length).toBeGreaterThan(0)
      expect(takings.netMinor).toBeGreaterThan(0)
      expect(takings.expectedCashMinor).toBeGreaterThan(0)
    })

    it('reports nothing for a day with no payments', async () => {
      const from = new Date('2020-01-01T00:00:00')
      const to = new Date('2020-01-02T00:00:00')

      const takings = await readTakings(restaurantId, ownerId, from, to)

      expect(takings.netMinor).toBe(0)
      expect(takings.byMethod).toEqual([])
    })
  })
})
