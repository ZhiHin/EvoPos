import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import {
  branches,
  diningSessions,
  insightDismissals,
  restaurants,
  salesRecords,
  users,
} from '@/lib/db/schema'
import {
  dismissInsight,
  readAdvisorReport,
  restoreInsight,
} from '@/modules/advisor/advisor.service'
import {
  createIngredient,
  recordCount,
  recordWastage,
  setRecipe,
} from '@/modules/inventory/inventory.service'
import { createItem } from '@/modules/menu/item.service'
import {
  settleAndCloseSession,
  takePayment,
} from '@/modules/payment/payment.service'
import { openTakeawaySession, placeStaffOrder } from '@/modules/pos/pos.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { businessDayRange } from '@/modules/reporting/report'
import { updateSettings } from '@/modules/settings/settings.service'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'

/**
 * The advisor against a real database.
 *
 * The rules are unit-tested in insights.test.ts — 41 tests, every threshold
 * and every refusal. What needs a database is that the evidence gatherer
 * actually finds what the rules expect, that a dismissal survives a recompute,
 * and that a snooze expires.
 *
 *   npm run db:migrate && npm run db:seed
 *   $env:RUN_DB_TESTS=1; npm test
 */

const enabled = process.env.RUN_DB_TESTS === '1'
const KL = 'Asia/Kuala_Lumpur'

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

describe.skipIf(!enabled)('the advisor', () => {
  let restaurantId: string
  let ownerId: string
  let branchId: string
  let costedItemId: string
  let ingredientId: string

  const ctx = () => ({ restaurantId, userId: ownerId })

  const reportCtx = () => ({
    restaurantId,
    userId: ownerId,
    timeZone: KL,
    businessDayStartMinutes: 0,
  })

  function wholeWindow() {
    const range = businessDayRange('2020-01-01', '2039-12-31', KL, 0)
    if (!range) throw new Error('Unreachable')
    return range
  }

  /** Settles `count` bills so the engine has enough trade to advise on. */
  async function trade(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      await placeStaffOrder(ctx(), sessionId, {
        lines: [
          { menuItemId: costedItemId, quantity: 1, modifierSelections: [] },
        ],
      })

      await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey: randomUUID(),
      })
      await settleAndCloseSession(ctx(), sessionId)
    }
  }

  async function clearTrade(): Promise<void> {
    await withTenant(ctx(), async (tx) => {
      await tx
        .delete(salesRecords)
        .where(eq(salesRecords.restaurantId, restaurantId))
      await tx
        .delete(insightDismissals)
        .where(eq(insightDismissals.restaurantId, restaurantId))
      await tx
        .update(diningSessions)
        .set({ status: 'abandoned' })
        .where(eq(diningSessions.restaurantId, restaurantId))
    })
  }

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `adv-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `Adv ${s}`))
    ).restaurantId

    const [branch] = await withTenant(ctx(), (tx) =>
      tx
        .insert(branches)
        .values({ restaurantId, name: 'Main', code: 'M1' })
        .returning({ id: branches.id }),
    )
    branchId = branch.id

    costedItemId = (
      await createItem(ctx(), { ...ITEM_BASE, name: 'Laksa', price: 1000 })
    ).id

    ingredientId = (
      await createIngredient(ctx(), {
        name: 'Noodles',
        unit: 'kg',
        costPerUnitMinor: 500,
        // A reorder point, so the reorder rule has something to fire on.
        reorderPointMilli: 5_000,
        reorderQuantityMilli: 20_000,
      })
    ).id

    await setRecipe(
      ctx(),
      { menuItemId: costedItemId },
      [{ ingredientId, quantityMilli: 200 }],
    )

    await recordCount(ctx(), branchId, ingredientId, 100_000)

    // No tax, so the arithmetic in these tests stays obvious.
    await updateSettings(ctx(), {
      name: 'Advisor',
      currency: 'MYR',
      timezone: KL,
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

  describe('refusing to advise', () => {
    it('declines on a quiet week and says why', async () => {
      await clearTrade()
      await trade(3)

      const report = await readAdvisorReport(reportCtx(), wholeWindow())

      expect(report.refusal).toMatch(/too few/i)
      // The briefing repeats the refusal rather than inventing a summary.
      expect(report.briefing.summary).toBe(report.refusal)
    })

    it('still raises a stock finding on that same quiet week', async () => {
      await clearTrade()
      await trade(3)

      // Drop below the reorder point. A counting error or a shortage is true
      // whatever the trade was.
      await recordCount(ctx(), branchId, ingredientId, 1_000)

      const report = await readAdvisorReport(reportCtx(), wholeWindow())

      expect(report.refusal).not.toBeNull()
      expect(report.insights.map((i) => i.key)).toContain(
        `inventory:reorder:${ingredientId}`,
      )

      await recordCount(ctx(), branchId, ingredientId, 100_000)
    })
  })

  describe('findings from real data', () => {
    it('reads wastage out of the stock ledger', async () => {
      await clearTrade()
      await trade(25)

      // 25 bowls consumed 5 kg; write off 1 kg, which is 20%.
      await recordWastage(ctx(), branchId, ingredientId, 1_000, 'Spoiled')

      const report = await readAdvisorReport(reportCtx(), wholeWindow())
      const wastage = report.insights.find(
        (i) => i.key === `inventory:wastage:${ingredientId}`,
      )

      expect(wastage).toBeDefined()
      expect(wastage!.evidence.map((e) => e.label)).toContain(
        'Value written off',
      )
      // RM 5.00 per kg.
      expect(wastage!.evidence).toContainEqual({
        label: 'Value written off',
        value: { kind: 'money', minor: 500 },
      })
    })

    it('carries evidence and a stated basis on every finding', async () => {
      await clearTrade()
      await trade(25)
      await recordWastage(ctx(), branchId, ingredientId, 1_000, 'Spoiled')

      const report = await readAdvisorReport(reportCtx(), wholeWindow())
      expect(report.insights.length).toBeGreaterThan(0)

      /**
       * The contract that makes the advisor worth reading: nothing is asserted
       * without the figures it came from and a statement of how much weight
       * they bear.
       */
      for (const insight of report.insights) {
        expect(insight.evidence.length).toBeGreaterThan(0)
        expect(insight.basis.length).toBeGreaterThan(0)
        expect(insight.recommendation.length).toBeGreaterThan(0)
      }
    })

    it('writes the briefing without a model, and says so', async () => {
      await clearTrade()
      await trade(25)
      await recordWastage(ctx(), branchId, ingredientId, 1_000, 'Spoiled')

      const report = await readAdvisorReport(reportCtx(), wholeWindow())

      // No key is configured in the test environment, and the advisor is fully
      // functional without one.
      expect(report.briefing.source).toBe('local')
      expect(report.briefing.degraded).toBeNull()
      expect(report.briefing.summary.length).toBeGreaterThan(0)
    })
  })

  describe('answering a recommendation', () => {
    const key = () => `inventory:wastage:${ingredientId}`

    async function withWastage(): Promise<void> {
      await clearTrade()
      await trade(25)
      await recordWastage(ctx(), branchId, ingredientId, 1_000, 'Spoiled')
    }

    it('hides it, and records who and why', async () => {
      await withWastage()

      await dismissInsight(ctx(), {
        insightKey: key(),
        reason: 'New supplier from Monday',
      })

      const report = await readAdvisorReport(reportCtx(), wholeWindow())

      expect(report.insights.map((i) => i.key)).not.toContain(key())
      expect(report.dismissed).toContainEqual({
        insightKey: key(),
        reason: 'New supplier from Monday',
        dismissedBy: 'Owner',
        snoozedUntil: null,
      })
    })

    it('keeps it hidden across a recompute', async () => {
      await withWastage()
      await dismissInsight(ctx(), {
        insightKey: key(),
        reason: 'Known',
      })

      // Worse numbers, same finding. A key that moved with the figures would
      // resurrect the dismissal exactly when it is least welcome.
      await recordWastage(ctx(), branchId, ingredientId, 2_000, 'More spoilage')

      const report = await readAdvisorReport(reportCtx(), wholeWindow())
      expect(report.insights.map((i) => i.key)).not.toContain(key())
    })

    it('brings a snoozed finding back when the snooze runs out', async () => {
      await withWastage()

      await dismissInsight(ctx(), {
        insightKey: key(),
        reason: 'Ordering this week',
        snoozeDays: 7,
      })

      const hidden = await readAdvisorReport(reportCtx(), wholeWindow())
      expect(hidden.insights.map((i) => i.key)).not.toContain(key())

      // Eight days later.
      const later = new Date(Date.now() + 8 * 24 * 60 * 60_000)
      const back = await readAdvisorReport(
        reportCtx(),
        wholeWindow(),
        null,
        later,
      )

      expect(back.insights.map((i) => i.key)).toContain(key())
      // The row survives the expiry — "we snoozed this in March and it came
      // back" is a question worth being able to answer.
      expect(back.dismissed).toEqual([])
    })

    it('replaces the answer rather than stacking rows', async () => {
      await withWastage()

      await dismissInsight(ctx(), { insightKey: key(), reason: 'First reason' })
      await dismissInsight(ctx(), { insightKey: key(), reason: 'Second reason' })

      const report = await readAdvisorReport(reportCtx(), wholeWindow())

      expect(report.dismissed).toHaveLength(1)
      expect(report.dismissed[0].reason).toBe('Second reason')
    })

    it('refuses a dismissal with no reason', async () => {
      await withWastage()

      await expect(
        dismissInsight(ctx(), { insightKey: key(), reason: '   ' }),
      ).rejects.toThrow(/why/i)
    })

    it('un-hides on request', async () => {
      await withWastage()
      await dismissInsight(ctx(), { insightKey: key(), reason: 'Known' })

      await restoreInsight(ctx(), key())

      const report = await readAdvisorReport(reportCtx(), wholeWindow())
      expect(report.insights.map((i) => i.key)).toContain(key())
      expect(report.dismissed).toEqual([])
    })
  })
})
