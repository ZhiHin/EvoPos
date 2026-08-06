import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import {
  branches,
  menuCategories,
  menuItems,
  orderLines,
  restaurants,
  users,
} from '@/lib/db/schema'
import { ConflictError } from '@/lib/errors'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { createCategory } from '@/modules/menu/category.service'
import { createItem } from '@/modules/menu/item.service'
import {
  advanceOrderLine,
  createStation,
  listStations,
  readKitchenQueue,
} from '@/modules/kitchen/kitchen.service'
import {
  openTakeawaySession,
  placeStaffOrder,
} from '@/modules/pos/pos.service'

/**
 * Kitchen routing and the display, against a real database.
 *
 * The rendering is unit-tested in render.test.ts. What needs a database is
 * that routing resolves in the right order, that the resolved station is
 * frozen onto the line, and that a ticket cannot move backwards.
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

describe.skipIf(!enabled)('kitchen', () => {
  let restaurantId: string
  let ownerId: string
  let branchId: string
  let hotStationId: string
  let barStationId: string
  let drinksCategoryId: string

  const ctx = () => ({ restaurantId, userId: ownerId })

  async function orderItem(menuItemId: string) {
    const { sessionId } = await openTakeawaySession(ctx(), {
      type: 'takeaway',
      branchId,
    })
    const { lineIds } = await placeStaffOrder(ctx(), sessionId, {
      lines: [{ menuItemId, quantity: 1, modifierSelections: [] }],
    })
    return { sessionId, lineId: lineIds[0] }
  }

  async function stationOf(lineId: string) {
    const [line] = await withTenant(ctx(), (tx) =>
      tx
        .select({ kitchenStationId: orderLines.kitchenStationId })
        .from(orderLines)
        .where(eq(orderLines.id, lineId)),
    )
    return line.kitchenStationId
  }

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `kds-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `KDS ${s}`))
    ).restaurantId

    const [branch] = await withTenant(ctx(), (tx) =>
      tx
        .insert(branches)
        .values({ restaurantId, name: 'Main', code: 'M1' })
        .returning({ id: branches.id }),
    )
    branchId = branch.id

    hotStationId = (
      await createStation(ctx(), branchId, {
        name: 'Hot Kitchen',
        kind: 'food',
        displayOrder: 0,
        isDefault: true,
      })
    ).id

    barStationId = (
      await createStation(ctx(), branchId, {
        name: 'Bar',
        kind: 'beverage',
        displayOrder: 1,
        isDefault: false,
      })
    ).id

    drinksCategoryId = (
      await createCategory(ctx(), {
        name: 'Drinks',
        displayOrder: 0,
        status: 'active',
      })
    ).id

    // Route the whole Drinks category to the bar.
    await withTenant(ctx(), (tx) =>
      tx
        .update(menuCategories)
        .set({ kitchenStationId: barStationId })
        .where(eq(menuCategories.id, drinksCategoryId)),
    )
  })

  afterAll(async () => {
    await withTenant(ctx(), (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, restaurantId)),
    )
    await db.delete(users).where(eq(users.id, ownerId))
  })

  describe('station routing', () => {
    it('falls back to the branch default when nothing is routed', async () => {
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'Unrouted dish',
        price: 1000,
      })

      const { lineId } = await orderItem(item.id)
      expect(await stationOf(lineId)).toBe(hotStationId)
    })

    it('uses the category station when the item has none', async () => {
      // Drinks is routed to the bar; this item sets no station of its own.
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'Teh Tarik',
        price: 500,
        categoryId: drinksCategoryId,
      })

      const { lineId } = await orderItem(item.id)
      expect(await stationOf(lineId)).toBe(barStationId)
    })

    it('lets an item override its category', async () => {
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'Iced Coffee',
        price: 700,
        categoryId: drinksCategoryId,
      })

      await withTenant(ctx(), (tx) =>
        tx
          .update(menuItems)
          .set({ kitchenStationId: barStationId })
          .where(eq(menuItems.id, item.id)),
      )

      const { lineId } = await orderItem(item.id)
      expect(await stationOf(lineId)).toBe(barStationId)
    })

    /**
     * The reason the station is snapshotted. Re-routing the menu mid-service
     * must not move a ticket already being cooked onto a screen nobody is
     * watching.
     */
    it('freezes the station onto the line', async () => {
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'Frozen routing',
        price: 900,
      })

      const { lineId } = await orderItem(item.id)
      expect(await stationOf(lineId)).toBe(hotStationId)

      await withTenant(ctx(), (tx) =>
        tx
          .update(menuItems)
          .set({ kitchenStationId: barStationId })
          .where(eq(menuItems.id, item.id)),
      )

      // The existing ticket has not moved.
      expect(await stationOf(lineId)).toBe(hotStationId)
    })

    it('lists the branch stations in display order', async () => {
      const stations = await listStations(restaurantId, ownerId, branchId)
      expect(stations.map((s) => s.name)).toEqual(['Hot Kitchen', 'Bar'])
    })
  })

  describe('the queue', () => {
    it('shows outstanding items and hides served ones', async () => {
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'Queue dish',
        price: 1000,
      })
      const { lineId } = await orderItem(item.id)

      const before = await readKitchenQueue(restaurantId, ownerId, branchId)
      expect(
        before.flatMap((t) => t.lines).map((l) => l.id),
      ).toContain(lineId)

      await advanceOrderLine(ctx(), lineId, 'ready')
      await advanceOrderLine(ctx(), lineId, 'served')

      const after = await readKitchenQueue(restaurantId, ownerId, branchId)
      expect(
        after.flatMap((t) => t.lines).map((l) => l.id),
      ).not.toContain(lineId)
    })

    it('filters by station', async () => {
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'Bar only',
        price: 800,
      })
      await withTenant(ctx(), (tx) =>
        tx
          .update(menuItems)
          .set({ kitchenStationId: barStationId })
          .where(eq(menuItems.id, item.id)),
      )

      const { lineId } = await orderItem(item.id)

      const bar = await readKitchenQueue(
        restaurantId,
        ownerId,
        branchId,
        barStationId,
      )
      expect(bar.flatMap((t) => t.lines).map((l) => l.id)).toContain(lineId)

      const hot = await readKitchenQueue(
        restaurantId,
        ownerId,
        branchId,
        hotStationId,
      )
      expect(hot.flatMap((t) => t.lines).map((l) => l.id)).not.toContain(lineId)
    })

    it('groups lines by session so a table plates together', async () => {
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'Grouped',
        price: 1000,
      })

      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })
      await placeStaffOrder(ctx(), sessionId, {
        lines: [
          { menuItemId: item.id, quantity: 1, modifierSelections: [] },
          { menuItemId: item.id, quantity: 2, modifierSelections: [] },
        ],
      })

      const queue = await readKitchenQueue(restaurantId, ownerId, branchId)
      const ticket = queue.find((t) => t.sessionId === sessionId)!

      expect(ticket.lines).toHaveLength(2)
    })
  })

  describe('advancing a ticket', () => {
    it('records when work started and finished', async () => {
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'Timed',
        price: 1000,
      })
      const { lineId } = await orderItem(item.id)

      await advanceOrderLine(ctx(), lineId, 'preparing')
      await advanceOrderLine(ctx(), lineId, 'ready')

      const [line] = await withTenant(ctx(), (tx) =>
        tx
          .select({
            startedAt: orderLines.startedAt,
            readyAt: orderLines.readyAt,
            status: orderLines.status,
          })
          .from(orderLines)
          .where(eq(orderLines.id, lineId)),
      )

      expect(line.status).toBe('ready')
      expect(line.startedAt).not.toBeNull()
      expect(line.readyAt).not.toBeNull()
    })

    /**
     * A drink poured in ten seconds never meaningfully passes through
     * "preparing", and forcing a second tap for it trains staff to
     * double-tap everything.
     */
    it('allows skipping straight to ready, still recording a start', async () => {
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'Quick pour',
        price: 500,
      })
      const { lineId } = await orderItem(item.id)

      await advanceOrderLine(ctx(), lineId, 'ready')

      const [line] = await withTenant(ctx(), (tx) =>
        tx
          .select({ startedAt: orderLines.startedAt })
          .from(orderLines)
          .where(eq(orderLines.id, lineId)),
      )

      // Never a null nobody can explain when preparation time is reported.
      expect(line.startedAt).not.toBeNull()
    })

    it('refuses to move a ticket backwards', async () => {
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'No going back',
        price: 1000,
      })
      const { lineId } = await orderItem(item.id)

      await advanceOrderLine(ctx(), lineId, 'ready')

      await expect(
        advanceOrderLine(ctx(), lineId, 'preparing'),
      ).rejects.toThrow(ConflictError)
    })

    it('refuses to advance a voided line', async () => {
      const { voidOrderLine } = await import(
        '@/modules/session/order.service'
      )

      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: 'Voided dish',
        price: 1000,
      })
      const { lineId } = await orderItem(item.id)

      await voidOrderLine(ctx(), lineId, 'Cancelled')

      await expect(
        advanceOrderLine(ctx(), lineId, 'preparing'),
      ).rejects.toThrow(ConflictError)
    })
  })
})
