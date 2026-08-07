import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withDiner, withTenant } from '@/lib/db'
import {
  billSplitShares,
  billSplits,
  branches,
  restaurants,
  users,
} from '@/lib/db/schema'
import { ConflictError } from '@/lib/errors'
import { hashToken } from '@/modules/auth/tokens'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { createItem } from '@/modules/menu/item.service'
import { createTable } from '@/modules/table/table.service'
import { updateSettings } from '@/modules/settings/settings.service'
import {
  lockSplit,
  previewSplit,
  readLockedSplitForStaff,
  voidSplit,
} from '@/modules/bill/bill.service'
import { computeSessionTotals } from '@/modules/pos/pos.service'
import {
  closeSession,
  joinByQrToken,
} from '@/modules/session/session.service'
import { placeDinerOrder } from '@/modules/session/order.service'

/**
 * Smart Bill against a real database.
 *
 * The allocation arithmetic is unit-tested in split.test.ts. What needs a
 * database is that a split built from stored rows still balances, that a
 * locked split stops moving, and that a diner sees their own share and only
 * their own table's.
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

describe.skipIf(!enabled)('Smart Bill', () => {
  let restaurantId: string
  let ownerId: string
  let qrA: string
  let qrB: string
  let nasiId: string
  let satayId: string

  const ctx = () => ({ restaurantId, userId: ownerId })

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `bill-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `Bill ${s}`))
    ).restaurantId

    const [branch] = await withTenant(ctx(), (tx) =>
      tx
        .insert(branches)
        .values({ restaurantId, name: 'Main', code: 'M1' })
        .returning({ id: branches.id }),
    )

    qrA = (await createTable(ctx(), branch.id, { code: 'B1', capacity: 4 }))
      .qrToken
    qrB = (await createTable(ctx(), branch.id, { code: 'B2', capacity: 4 }))
      .qrToken

    nasiId = (
      await createItem(ctx(), { ...ITEM_BASE, name: 'Nasi', price: 1200 })
    ).id
    satayId = (
      await createItem(ctx(), { ...ITEM_BASE, name: 'Satay', price: 1000 })
    ).id

    await updateSettings(ctx(), {
      name: `Bill ${s}`,
      currency: 'MYR',
      timezone: 'Asia/Kuala_Lumpur',
      locale: 'en',
      taxRatePercent: 600,
      serviceChargePercent: 1000,
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

  /** Seats two diners and gives them one personal dish each plus a shared one. */
  async function seatTable(qr: string) {
    const ali = await joinByQrToken(qr, 'Ali')
    const bee = await joinByQrToken(qr, 'Bee')

    await withDiner(hashToken(ali.token.token), (tx, diner) =>
      placeDinerOrder(tx, diner, {
        lines: [
          { menuItemId: nasiId, quantity: 1, isShared: false, modifierSelections: [] },
          { menuItemId: satayId, quantity: 1, isShared: true, modifierSelections: [] },
        ],
      }),
    )

    await withDiner(hashToken(bee.token.token), (tx, diner) =>
      placeDinerOrder(tx, diner, {
        lines: [
          { menuItemId: nasiId, quantity: 1, isShared: false, modifierSelections: [] },
        ],
      }),
    )

    return { ali, bee, sessionId: ali.sessionId }
  }

  describe('splitting a real bill', () => {
    it('balances exactly against the stored totals', async () => {
      const { sessionId } = await seatTable(qrA)

      const preview = await previewSplit(restaurantId, ownerId, sessionId, {
        kind: 'by_owner',
      })

      const sum = preview.shares.reduce((t, s) => t + s.totalMinor, 0)
      expect(sum).toBe(preview.totals.totalMinor)

      await closeSession(ctx(), sessionId)
    })

    it('charges each diner their own dish plus half the shared one', async () => {
      const { sessionId } = await seatTable(qrA)

      const preview = await previewSplit(restaurantId, ownerId, sessionId, {
        kind: 'by_owner',
      })

      const ali = preview.shares.find((s) => s.displayName === 'Ali')!
      const bee = preview.shares.find((s) => s.displayName === 'Bee')!

      // Ali: 1200 + 500 (half the satay). Bee: 1200 + 500.
      expect(ali.subtotalMinor).toBe(1700)
      expect(bee.subtotalMinor).toBe(1700)

      await closeSession(ctx(), sessionId)
    })

    it('divides everything equally under the even strategy', async () => {
      const { sessionId } = await seatTable(qrA)

      const preview = await previewSplit(restaurantId, ownerId, sessionId, {
        kind: 'even',
      })

      const [first, second] = preview.shares
      expect(first.totalMinor).toBe(second.totalMinor)
      expect(first.totalMinor + second.totalMinor).toBe(
        preview.totals.totalMinor,
      )

      await closeSession(ctx(), sessionId)
    })
  })

  describe('locking', () => {
    it('persists the shares and reports them back', async () => {
      const { sessionId } = await seatTable(qrA)

      const totals = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, sessionId),
      )

      const locked = await lockSplit(ctx(), sessionId, {
        strategy: { kind: 'by_owner' },
        expectedBillTotalMinor: totals.totalMinor,
      })

      expect(locked.shares).toHaveLength(2)

      const stored = await readLockedSplitForStaff(
        restaurantId,
        ownerId,
        sessionId,
      )
      expect(stored?.shares).toHaveLength(2)
      expect(
        stored!.shares.reduce((t, s) => t + s.totalMinor, 0),
      ).toBe(totals.totalMinor)

      await closeSession(ctx(), sessionId)
    })

    /**
     * The lost-update guard. If an order lands while the cashier is arranging
     * the split, locking would commit customers to amounts derived from a
     * bill nobody saw.
     */
    it('refuses to lock against a stale bill total', async () => {
      const { sessionId } = await seatTable(qrA)

      await expect(
        lockSplit(ctx(), sessionId, {
          strategy: { kind: 'by_owner' },
          expectedBillTotalMinor: 1, // deliberately wrong
        }),
      ).rejects.toThrow(ConflictError)

      await closeSession(ctx(), sessionId)
    })

    it('allows only one locked split per session', async () => {
      const { sessionId } = await seatTable(qrA)
      const totals = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, sessionId),
      )

      await lockSplit(ctx(), sessionId, {
        strategy: { kind: 'by_owner' },
        expectedBillTotalMinor: totals.totalMinor,
      })

      await expect(
        lockSplit(ctx(), sessionId, {
          strategy: { kind: 'even' },
          expectedBillTotalMinor: totals.totalMinor,
        }),
      ).rejects.toThrow(ConflictError)

      await closeSession(ctx(), sessionId)
    })

    /**
     * "Leave early" depends on this: someone agrees a number and walks out,
     * and a later round of drinks must not change what they already settled.
     */
    it('freezes the shares when more is ordered afterwards', async () => {
      const { ali, sessionId } = await seatTable(qrA)
      const totals = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, sessionId),
      )

      const locked = await lockSplit(ctx(), sessionId, {
        strategy: { kind: 'by_owner' },
        expectedBillTotalMinor: totals.totalMinor,
      })
      const agreed = locked.shares.map((s) => s.totalMinor)

      await withDiner(hashToken(ali.token.token), (tx, diner) =>
        placeDinerOrder(tx, diner, {
          lines: [
            { menuItemId: satayId, quantity: 2, isShared: false, modifierSelections: [] },
          ],
        }),
      )

      const stored = await readLockedSplitForStaff(
        restaurantId,
        ownerId,
        sessionId,
      )

      expect(stored!.shares.map((s) => s.totalMinor)).toEqual(agreed)
      // And the drift is visible rather than hidden.
      expect(stored!.currentBillTotalMinor).toBeGreaterThan(
        stored!.billTotalMinor,
      )

      await closeSession(ctx(), sessionId)
    })

    it('lets a voided split be replaced', async () => {
      const { sessionId } = await seatTable(qrA)
      const totals = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, sessionId),
      )

      const first = await lockSplit(ctx(), sessionId, {
        strategy: { kind: 'by_owner' },
        expectedBillTotalMinor: totals.totalMinor,
      })

      await voidSplit(ctx(), first.splitId, 'Customer changed their mind')

      await expect(
        lockSplit(ctx(), sessionId, {
          strategy: { kind: 'even' },
          expectedBillTotalMinor: totals.totalMinor,
        }),
      ).resolves.toBeDefined()

      // The voided row survives — what a customer was told still matters.
      const [voided] = await withTenant(ctx(), (tx) =>
        tx
          .select({ status: billSplits.status, reason: billSplits.voidReason })
          .from(billSplits)
          .where(eq(billSplits.id, first.splitId)),
      )
      expect(voided.status).toBe('void')
      expect(voided.reason).toBe('Customer changed their mind')

      await closeSession(ctx(), sessionId)
    })
  })

  describe('diner visibility', () => {
    it('shows a diner their own share', async () => {
      const { ali, sessionId } = await seatTable(qrA)
      const totals = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, sessionId),
      )

      await lockSplit(ctx(), sessionId, {
        strategy: { kind: 'by_owner' },
        expectedBillTotalMinor: totals.totalMinor,
      })

      const seen = await withDiner(hashToken(ali.token.token), (tx) =>
        tx.select().from(billSplitShares),
      )

      expect(seen).toHaveLength(2)
      expect(seen!.map((s) => s.displayNameSnapshot).sort()).toEqual([
        'Ali',
        'Bee',
      ])

      await closeSession(ctx(), sessionId)
    })

    /**
     * Table B must not see table A's split, even though both are locked in
     * the same restaurant at the same time.
     */
    it('does not show another table’s split', async () => {
      const tableA = await seatTable(qrA)
      const tableB = await seatTable(qrB)

      const totalsA = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, tableA.sessionId),
      )
      await lockSplit(ctx(), tableA.sessionId, {
        strategy: { kind: 'by_owner' },
        expectedBillTotalMinor: totalsA.totalMinor,
      })

      const seenByB = await withDiner(
        hashToken(tableB.ali.token.token),
        (tx) => tx.select().from(billSplitShares),
      )

      expect(seenByB).toHaveLength(0)

      await closeSession(ctx(), tableA.sessionId)
      await closeSession(ctx(), tableB.sessionId)
    })

    it('exposes no shares with no diner context', async () => {
      const rows = await db.select().from(billSplitShares)
      expect(rows).toHaveLength(0)
    })
  })
})
