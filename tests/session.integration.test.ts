import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withDiner, withTenant } from '@/lib/db'
import {
  branches,
  diningSessions,
  menuItems,
  orderLines,
  restaurants,
  users,
} from '@/lib/db/schema'
import { ConflictError } from '@/lib/errors'
import { hashToken } from '@/modules/auth/tokens'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { createItem } from '@/modules/menu/item.service'
import {
  attachModifierGroupToItem,
  createModifierGroup,
  createModifierOption,
} from '@/modules/modifier/modifier.service'
import { createTable } from '@/modules/table/table.service'
import { joinByQrToken, closeSession } from '@/modules/session/session.service'
import {
  placeDinerOrder,
  readSessionBill,
} from '@/modules/session/order.service'

/**
 * Dining sessions and diner isolation against a real database.
 *
 * The diner context is the only unauthenticated path that can WRITE, so these
 * tests carry more weight than most: they prove a diner reaches exactly one
 * session's bill, cannot acquire tenant access, and cannot dictate a price.
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

describe.skipIf(!enabled)('dining sessions', () => {
  let restaurantId: string
  let ownerId: string
  let otherRestaurantId: string
  let otherOwnerId: string

  let qrTokenA: string
  let qrTokenB: string
  let otherQrToken: string
  let nasiId: string
  let sizeGroupId: string
  let largeOptionId: string

  const ctx = () => ({ restaurantId, userId: ownerId })

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `sess-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    const [other] = await db
      .insert(users)
      .values({ email: `sess-o-${s}@test.local`, name: 'Other' })
      .returning({ id: users.id })

    ownerId = owner.id
    otherOwnerId = other.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `Sess ${s}`))
    ).restaurantId
    otherRestaurantId = (
      await db.transaction((tx) =>
        provisionRestaurant(tx, otherOwnerId, `SessO ${s}`),
      )
    ).restaurantId

    const [branch] = await withTenant(ctx(), (tx) =>
      tx
        .insert(branches)
        .values({ restaurantId, name: 'Main', code: 'M1' })
        .returning({ id: branches.id }),
    )
    const [otherBranch] = await withTenant(
      { restaurantId: otherRestaurantId, userId: otherOwnerId },
      (tx) =>
        tx
          .insert(branches)
          .values({ restaurantId: otherRestaurantId, name: 'Main', code: 'M1' })
          .returning({ id: branches.id }),
    )

    qrTokenA = (
      await createTable(ctx(), branch.id, { code: 'T1', capacity: 4 })
    ).qrToken
    qrTokenB = (
      await createTable(ctx(), branch.id, { code: 'T2', capacity: 2 })
    ).qrToken
    otherQrToken = (
      await createTable(
        { restaurantId: otherRestaurantId, userId: otherOwnerId },
        otherBranch.id,
        { code: 'T1', capacity: 2 },
      )
    ).qrToken

    nasiId = (
      await createItem(ctx(), { ...ITEM_BASE, name: 'Nasi Lemak', price: 1200 })
    ).id

    const group = await createModifierGroup(ctx(), {
      name: 'Size',
      minSelection: 1,
      maxSelection: 1,
      displayOrder: 0,
      status: 'active',
    })
    sizeGroupId = group.id

    await createModifierOption(ctx(), group.id, {
      name: 'Regular',
      priceDelta: 0,
      isDefault: true,
      maxQuantity: 1,
      displayOrder: 0,
      isAvailable: true,
    })
    largeOptionId = (
      await createModifierOption(ctx(), group.id, {
        name: 'Large',
        priceDelta: 300,
        isDefault: false,
        maxQuantity: 1,
        displayOrder: 1,
        isAvailable: true,
      })
    ).id

    await attachModifierGroupToItem(ctx(), nasiId, {
      modifierGroupId: group.id,
      displayOrder: 0,
    })
  })

  afterAll(async () => {
    await withTenant(ctx(), (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, restaurantId)),
    )
    await withTenant(
      { restaurantId: otherRestaurantId, userId: otherOwnerId },
      (tx) =>
        tx.delete(restaurants).where(eq(restaurants.id, otherRestaurantId)),
    )
    await db.delete(users).where(eq(users.id, ownerId))
    await db.delete(users).where(eq(users.id, otherOwnerId))
  })

  describe('joining', () => {
    it('opens a session on first scan', async () => {
      const result = await joinByQrToken(qrTokenB, 'First')
      expect(result.isNewSession).toBe(true)
      expect(result.table.code).toBe('T2')
    })

    /**
     * Two people scanning the same table must land on ONE bill. The partial
     * unique index is what guarantees it; a check-then-insert would let both
     * create a session and split the table in half.
     */
    it('puts a second scanner on the same session', async () => {
      const first = await joinByQrToken(qrTokenA, 'Ali')
      const second = await joinByQrToken(qrTokenA, 'Bee')

      expect(second.isNewSession).toBe(false)
      expect(second.sessionId).toBe(first.sessionId)
    })

    it('rejects an invalid QR token', async () => {
      await expect(joinByQrToken('z'.repeat(32), 'Nobody')).rejects.toThrow()
    })
  })

  describe('diner context isolation', () => {
    it('resolves a diner from their token', async () => {
      const joined = await joinByQrToken(qrTokenA, 'Cat')

      const seen = await withDiner(
        hashToken(joined.token.token),
        async (_tx, diner) => diner,
      )

      expect(seen?.sessionId).toBe(joined.sessionId)
      expect(seen?.displayName).toBe('Cat')
    })

    it('returns null for an unknown diner token', async () => {
      await expect(
        withDiner(hashToken('nope'), async () => 'reached'),
      ).resolves.toBeNull()
    })

    /**
     * The central claim of this phase. A diner must never acquire tenant
     * context — if they did, every tenant policy would open to an anonymous
     * stranger who scanned a sticker.
     */
    it('never grants tenant context to a diner', async () => {
      const joined = await joinByQrToken(qrTokenA, 'Dee')

      const leaked = await withDiner(
        hashToken(joined.token.token),
        async (tx) => {
          const rows = await tx.execute<{ tenant: string | null }>(
            sql`select nullif(current_setting('app.tenant_id', true), '') as tenant`,
          )
          return rows[0]?.tenant ?? null
        },
      )

      expect(leaked).toBeNull()
    })

    it('shows a diner only their own session’s lines', async () => {
      const tableA = await joinByQrToken(qrTokenA, 'Eve')
      const tableB = await joinByQrToken(qrTokenB, 'Fox')

      await withDiner(hashToken(tableA.token.token), (tx, diner) =>
        placeDinerOrder(tx, diner, {
          lines: [
            {
              menuItemId: nasiId,
              quantity: 1,
              isShared: false,
              modifierSelections: [
                { groupId: sizeGroupId, optionId: largeOptionId, quantity: 1 },
              ],
            },
          ],
        }),
      )

      const billB = await withDiner(hashToken(tableB.token.token), (tx, diner) =>
        readSessionBill(tx, diner.sessionId, diner.memberId),
      )

      // Table B must not see table A's food.
      expect(billB!.lines.map((l) => l.nameSnapshot)).not.toContain(
        'Nasi Lemak',
      )
    })

    it('sees no order lines at all with no diner context', async () => {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.session_id', '', true)`)
        return tx.select().from(orderLines)
      })

      expect(rows).toHaveLength(0)
    })

    it('does not let a diner cookie unlock another restaurant', async () => {
      const joined = await joinByQrToken(otherQrToken, 'Outsider')

      const seen = await withDiner(
        hashToken(joined.token.token),
        async (tx) => tx.select().from(menuItems),
      )

      // Their diner_tenant_id is the other restaurant, so this restaurant's
      // menu is invisible to them.
      expect(seen!.map((i) => i.id)).not.toContain(nasiId)
    })
  })

  describe('pricing and price freezing', () => {
    it('computes the price server-side from stored rules', async () => {
      const joined = await joinByQrToken(qrTokenA, 'Gus')

      const placed = await withDiner(hashToken(joined.token.token), (tx, diner) =>
        placeDinerOrder(tx, diner, {
          lines: [
            {
              menuItemId: nasiId,
              quantity: 2,
              isShared: false,
              modifierSelections: [
                { groupId: sizeGroupId, optionId: largeOptionId, quantity: 1 },
              ],
            },
          ],
        }),
      )

      // 2 × (1200 + 300) — deltas inside the unit price, then multiplied.
      expect(placed![0].lineTotalMinor).toBe(3000)
    })

    it('rejects an order that breaks a required modifier rule', async () => {
      const joined = await joinByQrToken(qrTokenA, 'Hal')

      await expect(
        withDiner(hashToken(joined.token.token), (tx, diner) =>
          placeDinerOrder(tx, diner, {
            lines: [
              {
                menuItemId: nasiId,
                quantity: 1,
                isShared: false,
                // Size is required and omitted entirely.
                modifierSelections: [],
              },
            ],
          }),
        ),
      ).rejects.toThrow()
    })

    /**
     * The reason every price is snapshotted. A manager repricing the menu
     * mid-service must not change what an already-seated table owes.
     */
    it('freezes the price against later menu edits', async () => {
      const joined = await joinByQrToken(qrTokenA, 'Ivy')

      const placed = await withDiner(hashToken(joined.token.token), (tx, diner) =>
        placeDinerOrder(tx, diner, {
          lines: [
            {
              menuItemId: nasiId,
              quantity: 1,
              isShared: false,
              modifierSelections: [
                { groupId: sizeGroupId, optionId: largeOptionId, quantity: 1 },
              ],
            },
          ],
        }),
      )

      const originalTotal = placed![0].lineTotalMinor

      await withTenant(ctx(), (tx) =>
        tx
          .update(menuItems)
          .set({ priceMinor: 9900 })
          .where(eq(menuItems.id, nasiId)),
      )

      const [line] = await withTenant(ctx(), (tx) =>
        tx
          .select({ lineTotalMinor: orderLines.lineTotalMinor })
          .from(orderLines)
          .where(eq(orderLines.id, placed![0].id)),
      )

      expect(line.lineTotalMinor).toBe(originalTotal)

      // Restore for any later assertions.
      await withTenant(ctx(), (tx) =>
        tx
          .update(menuItems)
          .set({ priceMinor: 1200 })
          .where(eq(menuItems.id, nasiId)),
      )
    })

    it('separates personal from shared totals', async () => {
      const joined = await joinByQrToken(qrTokenB, 'Jan')

      await withDiner(hashToken(joined.token.token), (tx, diner) =>
        placeDinerOrder(tx, diner, {
          lines: [
            {
              menuItemId: nasiId,
              quantity: 1,
              isShared: false,
              modifierSelections: [
                { groupId: sizeGroupId, optionId: largeOptionId, quantity: 1 },
              ],
            },
            {
              menuItemId: nasiId,
              quantity: 1,
              isShared: true,
              modifierSelections: [
                { groupId: sizeGroupId, optionId: largeOptionId, quantity: 1 },
              ],
            },
          ],
        }),
      )

      const bill = await withDiner(hashToken(joined.token.token), (tx, diner) =>
        readSessionBill(tx, diner.sessionId, diner.memberId),
      )

      expect(bill!.personalTotalMinor).toBeGreaterThan(0)
      expect(bill!.sharedTotalMinor).toBeGreaterThan(0)
      expect(bill!.sessionTotalMinor).toBe(
        bill!.personalTotalMinor + bill!.sharedTotalMinor,
      )
    })
  })

  describe('closing', () => {
    it('expires diner tokens when the session closes', async () => {
      const joined = await joinByQrToken(qrTokenB, 'Kim')

      await closeSession(ctx(), joined.sessionId)

      // The cookie on their phone is now inert.
      await expect(
        withDiner(hashToken(joined.token.token), async () => 'reached'),
      ).resolves.toBeNull()
    })

    it('frees the table so a new party can be seated', async () => {
      const first = await joinByQrToken(qrTokenB, 'Lee')
      await closeSession(ctx(), first.sessionId)

      const second = await joinByQrToken(qrTokenB, 'Moe')
      expect(second.isNewSession).toBe(true)
      expect(second.sessionId).not.toBe(first.sessionId)
    })

    it('refuses new items once the bill is requested', async () => {
      const joined = await joinByQrToken(qrTokenB, 'Ned')

      await withTenant(ctx(), (tx) =>
        tx
          .update(diningSessions)
          .set({ status: 'bill_requested' })
          .where(eq(diningSessions.id, joined.sessionId)),
      )

      await expect(
        withDiner(hashToken(joined.token.token), (tx, diner) =>
          placeDinerOrder(tx, diner, {
            lines: [
              {
                menuItemId: nasiId,
                quantity: 1,
                isShared: false,
                modifierSelections: [
                  { groupId: sizeGroupId, optionId: largeOptionId, quantity: 1 },
                ],
              },
            ],
          }),
        ),
      ).rejects.toThrow(ConflictError)

      await closeSession(ctx(), joined.sessionId)
    })
  })
})
