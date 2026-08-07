import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import {
  branches,
  diningSessions,
  diningTables,
  orderLines,
  restaurants,
  users,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { hashToken } from '@/modules/auth/tokens'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { createItem } from '@/modules/menu/item.service'
import { createTable } from '@/modules/table/table.service'
import { updateSettings } from '@/modules/settings/settings.service'
import {
  applyDiscount,
  computeSessionTotals,
  mergeSessions,
  openTakeawaySession,
  placeStaffOrder,
  removeDiscount,
  transferSession,
} from '@/modules/pos/pos.service'
import {
  closeSession,
  joinByQrToken,
  listLiveSessions,
  openSessionForTable,
} from '@/modules/session/session.service'
import { withDiner } from '@/lib/db'
import { placeDinerOrder } from '@/modules/session/order.service'

/**
 * POS operations against a real database.
 *
 * The bill arithmetic is unit-tested in bill.test.ts. What needs a database
 * is everything those pure functions cannot see: that merge moves every
 * referencing row, that transfer respects the one-session-per-table
 * constraint, and that totals computed from stored rows match the engine.
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

describe.skipIf(!enabled)('POS operations', () => {
  let restaurantId: string
  let ownerId: string
  let branchId: string
  let itemId: string
  const tableIds: string[] = []
  const qrTokens: string[] = []

  const ctx = () => ({ restaurantId, userId: ownerId })

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `pos-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `POS ${s}`))
    ).restaurantId

    const [branch] = await withTenant(ctx(), (tx) =>
      tx
        .insert(branches)
        .values({ restaurantId, name: 'Main', code: 'M1' })
        .returning({ id: branches.id }),
    )
    branchId = branch.id

    for (const code of ['P1', 'P2', 'P3', 'P4']) {
      const table = await createTable(ctx(), branchId, { code, capacity: 4 })
      tableIds.push(
        (
          await withTenant(ctx(), (tx) =>
            tx
              .select({ id: diningTables.id })
              .from(diningTables)
              .where(eq(diningTables.qrToken, table.qrToken)),
          )
        )[0].id,
      )
      qrTokens.push(table.qrToken)
    }

    itemId = (
      await createItem(ctx(), { ...ITEM_BASE, name: 'Teh Tarik', price: 1000 })
    ).id

    // 6% tax, 10% service charge, exclusive — the Phase 1 defaults made real.
    await updateSettings(ctx(), {
      name: `POS ${s}`,
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

  describe('takeaway and delivery', () => {
    it('opens a session with no table', async () => {
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
        customerName: 'Walk-in',
      })

      const [session] = await withTenant(ctx(), (tx) =>
        tx
          .select({
            tableId: diningSessions.tableId,
            type: diningSessions.type,
          })
          .from(diningSessions)
          .where(eq(diningSessions.id, sessionId)),
      )

      expect(session.tableId).toBeNull()
      expect(session.type).toBe('takeaway')
    })

    /**
     * The partial unique index is on table_id, and NULLs are distinct — so
     * unlimited table-less sessions coexist. This is also what makes "hold
     * order" free: each parked transaction is just another open session.
     */
    it('allows many concurrent takeaway sessions', async () => {
      const a = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
        customerName: 'A',
      })
      const b = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
        customerName: 'B',
      })

      expect(a.sessionId).not.toBe(b.sessionId)
    })

    it('shows table-less sessions on the floor', async () => {
      // A LEFT join, not INNER — an inner join would make every takeaway
      // order invisible to staff while remaining payable.
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'delivery',
        branchId,
        customerName: 'Delivery',
        deliveryAddress: '12 Jalan Test',
      })

      const live = await listLiveSessions(restaurantId, ownerId, branchId)
      expect(live.map((s) => s.id)).toContain(sessionId)
    })
  })

  describe('staff ordering', () => {
    it('prices a staff order the same as a diner order', async () => {
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: itemId, quantity: 3, modifierSelections: [] }],
      })

      const totals = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, sessionId),
      )

      expect(totals.subtotalMinor).toBe(3000)
    })

    it('refuses to attribute a line to a diner from another table', async () => {
      const other = await joinByQrToken(qrTokens[0], 'Someone')
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      await expect(
        placeStaffOrder(ctx(), sessionId, {
          lines: [
            {
              menuItemId: itemId,
              quantity: 1,
              memberId: other.memberId,
              modifierSelections: [],
            },
          ],
        }),
      ).rejects.toThrow(NotFoundError)

      await closeSession(ctx(), other.sessionId)
    })
  })

  describe('bill totals from stored rows', () => {
    it('matches the engine: subtotal, service charge, then tax on both', async () => {
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: itemId, quantity: 1, modifierSelections: [] }],
      })

      const totals = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, sessionId),
      )

      expect(totals.subtotalMinor).toBe(1000)
      expect(totals.serviceChargeMinor).toBe(100)
      expect(totals.taxMinor).toBe(66) // 6% of 1100
      expect(totals.totalMinor).toBe(1166)
    })

    it('reduces the service charge when a discount applies', async () => {
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: itemId, quantity: 1, modifierSelections: [] }],
      })

      await applyDiscount(ctx(), sessionId, {
        type: 'percentage',
        value: 1000,
        reason: 'Regular customer',
      })

      const totals = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, sessionId),
      )

      expect(totals.discountMinor).toBe(100)
      expect(totals.discountedSubtotalMinor).toBe(900)
      expect(totals.serviceChargeMinor).toBe(90)
      expect(totals.totalMinor).toBe(1049)
    })

    it('excludes a removed discount but keeps its row', async () => {
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: itemId, quantity: 1, modifierSelections: [] }],
      })

      const discount = await applyDiscount(ctx(), sessionId, {
        type: 'fixed',
        value: 200,
        reason: 'Comped drink',
      })

      await removeDiscount(ctx(), discount.id)

      const totals = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, sessionId),
      )

      expect(totals.discountMinor).toBe(0)
      expect(totals.discounts).toHaveLength(0)
    })

    it('refuses to remove the same discount twice', async () => {
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      const discount = await applyDiscount(ctx(), sessionId, {
        type: 'fixed',
        value: 100,
        reason: 'Once',
      })

      await removeDiscount(ctx(), discount.id)
      await expect(removeDiscount(ctx(), discount.id)).rejects.toThrow(
        ConflictError,
      )
    })
  })

  describe('transfer', () => {
    it('moves a session to a free table', async () => {
      const opened = await openSessionForTable(ctx(), tableIds[1])

      await transferSession(ctx(), opened.sessionId, { tableId: tableIds[2] })

      const [session] = await withTenant(ctx(), (tx) =>
        tx
          .select({ tableId: diningSessions.tableId })
          .from(diningSessions)
          .where(eq(diningSessions.id, opened.sessionId)),
      )

      expect(session.tableId).toBe(tableIds[2])

      // The vacated table must be free again for the next party.
      const [old] = await withTenant(ctx(), (tx) =>
        tx
          .select({ status: diningTables.status })
          .from(diningTables)
          .where(eq(diningTables.id, tableIds[1])),
      )
      expect(old.status).toBe('available')

      await closeSession(ctx(), opened.sessionId)
    })

    it('refuses to transfer onto a table with an open bill', async () => {
      const a = await openSessionForTable(ctx(), tableIds[1])
      const b = await openSessionForTable(ctx(), tableIds[2])

      await expect(
        transferSession(ctx(), a.sessionId, { tableId: tableIds[2] }),
      ).rejects.toThrow(ConflictError)

      await closeSession(ctx(), a.sessionId)
      await closeSession(ctx(), b.sessionId)
    })
  })

  describe('merge', () => {
    /**
     * Every table referencing the source must move. A line left behind would
     * vanish from both bills — ordered, cooked, and charged to nobody.
     */
    it('moves lines, members and discounts to the surviving bill', async () => {
      const target = await joinByQrToken(qrTokens[1], 'Target')
      const source = await joinByQrToken(qrTokens[2], 'Source')

      await withDiner(hashToken(source.token.token), (tx, diner) =>
        placeDinerOrder(tx, diner, {
          lines: [
            { menuItemId: itemId, quantity: 2, isShared: false, modifierSelections: [] },
          ],
        }),
      )

      await applyDiscount(ctx(), source.sessionId, {
        type: 'fixed',
        value: 100,
        reason: 'Moving discount',
      })

      const result = await mergeSessions(ctx(), target.sessionId, {
        sourceSessionId: source.sessionId,
      })

      expect(result.movedLines).toBe(1)

      const lines = await withTenant(ctx(), (tx) =>
        tx
          .select({ id: orderLines.id })
          .from(orderLines)
          .where(eq(orderLines.sessionId, target.sessionId)),
      )
      expect(lines).toHaveLength(1)

      const totals = await withTenant(ctx(), (tx) =>
        computeSessionTotals(tx, restaurantId, target.sessionId),
      )
      // Subtotal 2000, discount 100 moved across with it.
      expect(totals.subtotalMinor).toBe(2000)
      expect(totals.discountMinor).toBe(100)

      await closeSession(ctx(), target.sessionId)
    })

    it('closes the absorbed session and frees its table', async () => {
      const target = await joinByQrToken(qrTokens[1], 'T')
      const source = await joinByQrToken(qrTokens[2], 'S')

      await mergeSessions(ctx(), target.sessionId, {
        sourceSessionId: source.sessionId,
      })

      const [closed] = await withTenant(ctx(), (tx) =>
        tx
          .select({ status: diningSessions.status })
          .from(diningSessions)
          .where(eq(diningSessions.id, source.sessionId)),
      )
      expect(closed.status).toBe('closed')

      // The freed table can seat a new party immediately.
      const reopened = await joinByQrToken(qrTokens[2], 'New party')
      expect(reopened.isNewSession).toBe(true)

      await closeSession(ctx(), target.sessionId)
      await closeSession(ctx(), reopened.sessionId)
    })

    it('refuses to merge a bill into itself', async () => {
      const only = await openSessionForTable(ctx(), tableIds[3])

      await expect(
        mergeSessions(ctx(), only.sessionId, {
          sourceSessionId: only.sessionId,
        }),
      ).rejects.toThrow(ConflictError)

      await closeSession(ctx(), only.sessionId)
    })
  })
})
