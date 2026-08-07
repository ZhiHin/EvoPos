import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import {
  branches,
  loyaltyTiers,
  loyaltyTransactions,
  promotions,
  restaurants,
  users,
  vouchers,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { createItem } from '@/modules/menu/item.service'
import {
  openTakeawaySession,
  placeStaffOrder,
} from '@/modules/pos/pos.service'
import { computeSessionTotals } from '@/modules/pos/pos.service'
import {
  adjustPoints,
  earnPointsForSession,
  findOrCreateCustomer,
  readCustomer,
  redeemPoints,
} from '@/modules/promotion/loyalty.service'
import {
  applyPromotions,
  redeemVoucher,
} from '@/modules/promotion/promotion.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { updateSettings } from '@/modules/settings/settings.service'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'

/**
 * Promotions and loyalty against a real database.
 *
 * The evaluation arithmetic is unit-tested in engine.test.ts. What needs a
 * database is the usage cap holding under a real UPDATE, that re-applying
 * does not stack, that a voucher burns exactly once, and that the ledger is
 * the only place a points balance comes from.
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

describe.skipIf(!enabled)('promotions and loyalty', () => {
  let restaurantId: string
  let ownerId: string
  let branchId: string
  let itemId: string

  const ctx = () => ({ restaurantId, userId: ownerId })

  /** Opens a takeaway bill of `quantity` × RM 10.00. */
  async function billFor(quantity = 1): Promise<string> {
    const { sessionId } = await openTakeawaySession(ctx(), {
      type: 'takeaway',
      branchId,
    })

    await placeStaffOrder(ctx(), sessionId, {
      lines: [{ menuItemId: itemId, quantity, modifierSelections: [] }],
    })

    return sessionId
  }

  async function makePromotion(
    overrides: Partial<typeof promotions.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await withTenant(ctx(), (tx) =>
      tx
        .insert(promotions)
        .values({
          restaurantId,
          name: `Promo ${randomUUID().slice(0, 8)}`,
          kind: 'percentage',
          value: 1000, // 10%
          priority: 100,
          isStackable: true,
          isActive: true,
          daysOfWeek: [],
          branchIds: [],
          categoryIds: [],
          menuItemIds: [],
          ...overrides,
        })
        .returning({ id: promotions.id }),
    )

    return row.id
  }

  async function totalOf(sessionId: string): Promise<number> {
    return withTenant(ctx(), async (tx) => {
      return (await computeSessionTotals(tx, restaurantId, sessionId))
        .totalMinor
    })
  }

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `promo-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    restaurantId = (
      await db.transaction((tx) =>
        provisionRestaurant(tx, ownerId, `Promo ${s}`),
      )
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

    // No tax or service charge, so a 10% promotion is visibly 10%.
    await updateSettings(ctx(), {
      name: `Promo ${s}`,
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

  describe('applying promotions', () => {
    it('discounts the bill and records what fired', async () => {
      const promotionId = await makePromotion()
      const sessionId = await billFor()

      const applied = await applyPromotions(ctx(), sessionId)

      expect(applied).toHaveLength(1)
      expect(applied[0].promotionId).toBe(promotionId)
      expect(applied[0].discountMinor).toBe(100)
      expect(await totalOf(sessionId)).toBe(900)

      await withTenant(ctx(), (tx) =>
        tx.delete(promotions).where(eq(promotions.id, promotionId)),
      )
    })

    it('does not stack the same promotion when re-applied', async () => {
      const promotionId = await makePromotion()
      const sessionId = await billFor()

      await applyPromotions(ctx(), sessionId)
      await applyPromotions(ctx(), sessionId)

      /**
       * The realistic failure: a cashier adds an item, presses the button
       * again, and the bill quietly halves. Re-evaluation must replace, not
       * append.
       */
      expect(await totalOf(sessionId)).toBe(900)

      await withTenant(ctx(), (tx) =>
        tx.delete(promotions).where(eq(promotions.id, promotionId)),
      )
    })

    it('skips a promotion whose minimum spend is not met', async () => {
      const promotionId = await makePromotion({ minSpendMinor: 5000 })
      const sessionId = await billFor() // RM 10.00

      expect(await applyPromotions(ctx(), sessionId)).toHaveLength(0)
      expect(await totalOf(sessionId)).toBe(1000)

      await withTenant(ctx(), (tx) =>
        tx.delete(promotions).where(eq(promotions.id, promotionId)),
      )
    })

    it('never applies a voucher-only promotion automatically', async () => {
      const promotionId = await makePromotion({ requiresVoucher: true })
      const sessionId = await billFor()

      expect(await applyPromotions(ctx(), sessionId)).toHaveLength(0)

      await withTenant(ctx(), (tx) =>
        tx.delete(promotions).where(eq(promotions.id, promotionId)),
      )
    })

    it('stops at the total usage cap', async () => {
      const promotionId = await makePromotion({ maxUsageTotal: 1 })

      const first = await applyPromotions(ctx(), await billFor())
      const second = await applyPromotions(ctx(), await billFor())

      expect(first).toHaveLength(1)
      expect(second).toHaveLength(0)

      const [row] = await withTenant(ctx(), (tx) =>
        tx
          .select({ usageCount: promotions.usageCount })
          .from(promotions)
          .where(eq(promotions.id, promotionId)),
      )

      // The counter is the cap. If it overshot, the conditional UPDATE that
      // claims a use is not doing its job and two tills could both win.
      expect(row.usageCount).toBe(1)

      await withTenant(ctx(), (tx) =>
        tx.delete(promotions).where(eq(promotions.id, promotionId)),
      )
    })
  })

  describe('vouchers', () => {
    async function issue(
      promotionId: string,
      overrides: Partial<typeof vouchers.$inferInsert> = {},
    ): Promise<string> {
      const code = `V${randomUUID().slice(0, 8).toUpperCase()}`

      await withTenant(ctx(), (tx) =>
        tx.insert(vouchers).values({
          restaurantId,
          promotionId,
          code,
          ...overrides,
        }),
      )

      return code
    }

    it('applies a voucher-only promotion when the code is given', async () => {
      const promotionId = await makePromotion({ requiresVoucher: true })
      const code = await issue(promotionId)
      const sessionId = await billFor()

      const result = await redeemVoucher(ctx(), sessionId, code)

      expect(result.discountMinor).toBe(100)
      expect(await totalOf(sessionId)).toBe(900)

      await withTenant(ctx(), (tx) =>
        tx.delete(promotions).where(eq(promotions.id, promotionId)),
      )
    })

    it('accepts a code in any case', async () => {
      const promotionId = await makePromotion({ requiresVoucher: true })
      const code = await issue(promotionId)
      const sessionId = await billFor()

      // Read off a printed slip by hand, so case is not the customer's problem.
      await expect(
        redeemVoucher(ctx(), sessionId, ` ${code.toLowerCase()} `),
      ).resolves.toMatchObject({ discountMinor: 100 })

      await withTenant(ctx(), (tx) =>
        tx.delete(promotions).where(eq(promotions.id, promotionId)),
      )
    })

    it('refuses a second redemption of a single-use code', async () => {
      const promotionId = await makePromotion({ requiresVoucher: true })
      const code = await issue(promotionId)

      await redeemVoucher(ctx(), await billFor(), code)

      await expect(
        redeemVoucher(ctx(), await billFor(), code),
      ).rejects.toBeInstanceOf(ConflictError)

      await withTenant(ctx(), (tx) =>
        tx.delete(promotions).where(eq(promotions.id, promotionId)),
      )
    })

    it('refuses an expired code', async () => {
      const promotionId = await makePromotion({ requiresVoucher: true })
      const code = await issue(promotionId, {
        expiresAt: new Date(Date.now() - 60_000),
      })

      await expect(
        redeemVoucher(ctx(), await billFor(), code),
      ).rejects.toBeInstanceOf(NotFoundError)

      await withTenant(ctx(), (tx) =>
        tx.delete(promotions).where(eq(promotions.id, promotionId)),
      )
    })

    it('gives an unknown code the same answer as an expired one', async () => {
      const promotionId = await makePromotion({ requiresVoucher: true })
      const expired = await issue(promotionId, {
        expiresAt: new Date(Date.now() - 60_000),
      })

      const unknownError = await redeemVoucher(
        ctx(),
        await billFor(),
        'NOSUCHCODE',
      ).catch((cause: Error) => cause.message)

      const expiredError = await redeemVoucher(
        ctx(),
        await billFor(),
        expired,
      ).catch((cause: Error) => cause.message)

      /**
       * A differentiated message turns this endpoint into an oracle: guess
       * codes until "expired" comes back instead of "unknown", and you have
       * learned which prefixes are real.
       */
      expect(unknownError).toBe(expiredError)

      await withTenant(ctx(), (tx) =>
        tx.delete(promotions).where(eq(promotions.id, promotionId)),
      )
    })
  })

  describe('loyalty', () => {
    it('returns the same customer for a repeated phone number', async () => {
      const phone = `+601${randomUUID().slice(0, 8)}`

      const first = await findOrCreateCustomer(ctx(), { name: 'Ana', phone })
      const second = await findOrCreateCustomer(ctx(), { name: 'Ana', phone })

      expect(first.wasCreated).toBe(true)
      expect(second.wasCreated).toBe(false)
      expect(second.id).toBe(first.id)
    })

    it('awards points for a bill and only once per session', async () => {
      const { id } = await findOrCreateCustomer(ctx(), {
        name: 'Ben',
        phone: `+601${randomUUID().slice(0, 8)}`,
      })
      const sessionId = await billFor()

      const first = await earnPointsForSession(ctx(), id, sessionId, 1000)
      const replay = await earnPointsForSession(ctx(), id, sessionId, 1000)

      expect(first.pointsEarned).toBe(10)
      expect(replay.wasReplay).toBe(true)
      expect(replay.pointsEarned).toBe(0)

      const customer = await readCustomer(restaurantId, ownerId, id)
      expect(customer.pointsBalance).toBe(10)
    })

    it('refuses to redeem more points than the ledger holds', async () => {
      const { id } = await findOrCreateCustomer(ctx(), {
        name: 'Cara',
        phone: `+601${randomUUID().slice(0, 8)}`,
      })

      await adjustPoints(ctx(), id, 50, 'Goodwill')

      await expect(
        redeemPoints(ctx(), id, 51, 'Free coffee'),
      ).rejects.toBeInstanceOf(ConflictError)

      const customer = await readCustomer(restaurantId, ownerId, id)
      expect(customer.pointsBalance).toBe(50)
    })

    it('reads the balance from the ledger, not a stored total', async () => {
      const { id } = await findOrCreateCustomer(ctx(), {
        name: 'Dee',
        phone: `+601${randomUUID().slice(0, 8)}`,
      })

      await adjustPoints(ctx(), id, 100, 'Goodwill')
      await redeemPoints(ctx(), id, 30, 'Free coffee')

      const customer = await readCustomer(restaurantId, ownerId, id)
      expect(customer.pointsBalance).toBe(70)

      // Lifetime counts only what was earned, so spending does not demote.
      expect(customer.lifetimePoints).toBe(100)

      const rows = await withTenant(ctx(), (tx) =>
        tx
          .select({ points: loyaltyTransactions.points })
          .from(loyaltyTransactions)
          .where(eq(loyaltyTransactions.customerId, id)),
      )

      expect(rows.reduce((sum, row) => sum + row.points, 0)).toBe(70)
    })

    it('promotes to the highest tier the lifetime points reach', async () => {
      const [silver] = await withTenant(ctx(), (tx) =>
        tx
          .insert(loyaltyTiers)
          .values({
            restaurantId,
            name: `Silver ${randomUUID().slice(0, 4)}`,
            minPoints: 100,
            displayOrder: 1,
          })
          .returning({ id: loyaltyTiers.id }),
      )

      const [gold] = await withTenant(ctx(), (tx) =>
        tx
          .insert(loyaltyTiers)
          .values({
            restaurantId,
            name: `Gold ${randomUUID().slice(0, 4)}`,
            minPoints: 500,
            displayOrder: 2,
          })
          .returning({ id: loyaltyTiers.id }),
      )

      const { id } = await findOrCreateCustomer(ctx(), {
        name: 'Eve',
        phone: `+601${randomUUID().slice(0, 8)}`,
      })

      await adjustPoints(ctx(), id, 150, 'Goodwill')
      expect((await readCustomer(restaurantId, ownerId, id)).tierId).toBe(
        silver.id,
      )

      await adjustPoints(ctx(), id, 400, 'Goodwill')
      expect((await readCustomer(restaurantId, ownerId, id)).tierId).toBe(
        gold.id,
      )

      // Spending points must not take the tier away — it is recognition of
      // what was spent, not of what is left over.
      await redeemPoints(ctx(), id, 500, 'Big reward')
      expect((await readCustomer(restaurantId, ownerId, id)).tierId).toBe(
        gold.id,
      )

      await withTenant(ctx(), async (tx) => {
        await tx.delete(loyaltyTiers).where(eq(loyaltyTiers.id, silver.id))
        await tx.delete(loyaltyTiers).where(eq(loyaltyTiers.id, gold.id))
      })
    })
  })
})
