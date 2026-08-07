import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import {
  branches,
  diningSessions,
  orderLines,
  restaurants,
  salesRecords,
  users,
} from '@/lib/db/schema'
import { zonedTimeToInstant } from '@/lib/time'
import { createItem } from '@/modules/menu/item.service'
import {
  createIngredient,
  recordCount,
  setRecipe,
} from '@/modules/inventory/inventory.service'
import {
  issueRefund,
  settleAndCloseSession,
  takePayment,
} from '@/modules/payment/payment.service'
import {
  applyDiscount,
  openTakeawaySession,
  placeStaffOrder,
} from '@/modules/pos/pos.service'
import { voidOrderLine } from '@/modules/session/order.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { businessDayRange } from '@/modules/reporting/report'
import {
  readItemReport,
  readLossReport,
  readSalesReport,
  readTaxReport,
} from '@/modules/reporting/report.service'
import { readLiveOperations } from '@/modules/reporting/operations.service'
import { updateSettings } from '@/modules/settings/settings.service'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'

/**
 * Reporting against a real database.
 *
 * The arithmetic is unit-tested in report.test.ts and the writers in
 * export.test.ts. What needs a database is the thing this whole phase exists
 * for: that a report of a closed period does not move when the settings that
 * produced it are changed.
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

describe.skipIf(!enabled)('reporting', () => {
  let restaurantId: string
  let ownerId: string
  let branchId: string
  /** RM 10.00, with a recipe, so it carries a cost. */
  let costedItemId: string
  /** RM 20.00, no recipe — the item that makes margin a half-truth. */
  let uncostedItemId: string
  let ingredientId: string

  const ctx = () => ({ restaurantId, userId: ownerId })
  const key = () => randomUUID()

  const reportCtx = (startMinutes = 0) => ({
    restaurantId,
    userId: ownerId,
    timeZone: KL,
    businessDayStartMinutes: startMinutes,
  })

  /** The widest range these tests ever need. */
  function wholeWindow(startMinutes = 0) {
    const range = businessDayRange(
      '2020-01-01',
      '2039-12-31',
      KL,
      startMinutes,
    )
    if (!range) throw new Error('Unreachable')
    return { range, branchId: null }
  }

  async function sellAndSettle(
    lines: { menuItemId: string; quantity: number }[],
    options: { guestCount?: number } = {},
  ): Promise<string> {
    const { sessionId } = await openTakeawaySession(ctx(), {
      type: 'takeaway',
      branchId,
    })

    /**
     * A takeaway bag has no covers, so the count is set directly rather than
     * through a path that would refuse it. It is the same column the dine-in
     * flow writes; only the way it got there differs.
     */
    if (options.guestCount !== undefined) {
      await withTenant(ctx(), (tx) =>
        tx
          .update(diningSessions)
          .set({ guestCount: options.guestCount })
          .where(eq(diningSessions.id, sessionId)),
      )
    }

    await placeStaffOrder(ctx(), sessionId, {
      lines: lines.map((line) => ({ ...line, modifierSelections: [] })),
    })

    return sessionId
  }

  async function payAndClose(sessionId: string, amountMinor: number) {
    await takePayment(ctx(), sessionId, {
      method: 'cash',
      amount: amountMinor,
      tendered: amountMinor,
      idempotencyKey: key(),
    })
    await settleAndCloseSession(ctx(), sessionId)
  }

  /**
   * `updateSettings` takes the POST-transform input, so its `taxRatePercent`
   * is already basis points — the schema's percent-to-basis-points conversion
   * has run by then. Passing 6 here would set 0.06%, and every bill would come
   * out one sen short of settled.
   */
  async function setTaxBasisPoints(basisPoints: number): Promise<void> {
    await updateSettings(ctx(), {
      name: 'Reporting',
      currency: 'MYR',
      timezone: KL,
      locale: 'en',
      taxRatePercent: basisPoints,
      serviceChargePercent: 0,
      taxInclusive: false,
      businessDayStartMinutes: 0,
    })
  }

  /**
   * Wipes settled history and returns the tax rate to zero, so each test reads
   * only its own bills at a rate it chose. Resetting only at the end of a test
   * leaves the rate wherever a failure abandoned it, and every later test then
   * fails for a reason that has nothing to do with what it was checking.
   */
  async function resetPeriod(): Promise<void> {
    await withTenant(ctx(), (tx) =>
      tx.delete(salesRecords).where(eq(salesRecords.restaurantId, restaurantId)),
    )
    await setTaxBasisPoints(0)
  }

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `rep-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `Rep ${s}`))
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
    uncostedItemId = (
      await createItem(ctx(), { ...ITEM_BASE, name: 'Wine', price: 2000 })
    ).id

    // RM 5.00 per kg, and 200 g per bowl — so one Laksa costs RM 1.00.
    ingredientId = (
      await createIngredient(ctx(), {
        name: 'Noodles',
        unit: 'kg',
        costPerUnitMinor: 500,
        reorderPointMilli: 0,
        reorderQuantityMilli: 0,
      })
    ).id

    await setRecipe(
      ctx(),
      { menuItemId: costedItemId },
      [{ ingredientId, quantityMilli: 200 }],
    )

    // 100 kg on the shelf, so nothing in these tests runs short.
    await recordCount(ctx(), branchId, ingredientId, 100_000)

    await setTaxBasisPoints(0)
  })

  afterAll(async () => {
    await withTenant(ctx(), (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, restaurantId)),
    )
    await db.delete(users).where(eq(users.id, ownerId))
  })

  describe('the sales snapshot', () => {
    it('records a bill when it settles, and not before', async () => {
      await resetPeriod()
      const sessionId = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 1 },
      ])

      await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey: key(),
      })

      // Paid but not closed: no sale yet, because the bill can still change.
      expect(await countRecords()).toBe(0)

      await settleAndCloseSession(ctx(), sessionId)
      expect(await countRecords()).toBe(1)
    })

    it('writes one record however many times settlement is retried', async () => {
      await resetPeriod()
      const sessionId = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 1 },
      ])
      await payAndClose(sessionId, 1000)

      /**
       * A second close must not double the day's reported revenue. Every
       * underlying payment would still be correct, so the discrepancy would
       * only ever show in the total — which is the hardest place to find it.
       */
      await settleAndCloseSession(ctx(), sessionId).catch(() => undefined)

      expect(await countRecords()).toBe(1)
    })

    it('snapshots the cost of what was actually consumed', async () => {
      await resetPeriod()
      const sessionId = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 3 },
      ])
      await payAndClose(sessionId, 3000)

      const report = await readSalesReport(reportCtx(), wholeWindow())

      // 3 bowls × 200 g × RM 5.00/kg = RM 3.00.
      expect(report.summary.costMinor).toBe(300)
      expect(report.summary.netSalesMinor).toBe(3000)
      expect(report.summary.grossProfitMinor).toBe(2700)
    })

    it('agrees with itself: the ledger and the line snapshots match', async () => {
      await resetPeriod()
      const sessionId = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 2 },
        { menuItemId: uncostedItemId, quantity: 1 },
      ])
      await payAndClose(sessionId, 4000)

      /**
       * The bill's cost is read from the stock ledger — what actually left the
       * shelf. Per-dish cost is read from the snapshot frozen onto each line,
       * because a consumption movement covers a whole order and cannot say
       * which dish consumed what.
       *
       * Two sources for one number is a standing invitation to drift, so the
       * agreement is asserted rather than assumed.
       */
      const [lineCosts] = await withTenant(ctx(), (tx) =>
        tx
          .select({
            total: sql<number>`coalesce(sum(${orderLines.costMinor}), 0)::int`,
          })
          .from(orderLines)
          .where(eq(orderLines.sessionId, sessionId)),
      )

      const report = await readSalesReport(reportCtx(), wholeWindow())

      expect(report.summary.costMinor).toBe(200)
      expect(lineCosts.total).toBe(report.summary.costMinor)
    })

    it('leaves a line with no recipe null rather than costing it nothing', async () => {
      await resetPeriod()
      const sessionId = await sellAndSettle([
        { menuItemId: uncostedItemId, quantity: 1 },
      ])
      await payAndClose(sessionId, 2000)

      const rows = await withTenant(ctx(), (tx) =>
        tx
          .select({ costMinor: orderLines.costMinor })
          .from(orderLines)
          .where(eq(orderLines.sessionId, sessionId)),
      )

      // Zero would claim the wine is free to make. Null says nobody costed it.
      expect(rows).toHaveLength(1)
      expect(rows[0].costMinor).toBeNull()
    })
  })

  /**
   * The reason this phase added a table rather than a query.
   */
  describe('a closed period does not move', () => {
    it('keeps the tax that was charged when the rate later changes', async () => {
      await resetPeriod()
      await setTaxBasisPoints(600)

      const sessionId = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 1 },
      ])
      await payAndClose(sessionId, 1060)

      const before = await readTaxReport(reportCtx(), wholeWindow())
      expect(before.totalTaxMinor).toBe(60)
      expect(before.lines[0].rateBasisPoints).toBe(600)

      // The government raises SST. Every future bill charges 8%.
      await setTaxBasisPoints(800)

      const after = await readTaxReport(reportCtx(), wholeWindow())

      /**
       * Unchanged. A report recomputed from live settings would now say 80
       * sen — restating a return that may already have been filed, with
       * nothing in the system recording that the number moved.
       */
      expect(after.totalTaxMinor).toBe(60)
      expect(after.lines[0].rateBasisPoints).toBe(600)

      await setTaxBasisPoints(0)
    })

    it('reports a rate change as two lines, not one blended figure', async () => {
      await resetPeriod()

      await setTaxBasisPoints(600)
      const first = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 1 },
      ])
      await payAndClose(first, 1060)

      await setTaxBasisPoints(800)
      const second = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 1 },
      ])
      await payAndClose(second, 1080)

      const report = await readTaxReport(reportCtx(), wholeWindow())

      expect(report.lines).toHaveLength(2)
      expect(report.lines.map((line) => line.rateBasisPoints)).toEqual([
        800, 600,
      ])
      expect(report.totalTaxMinor).toBe(140)

      await setTaxBasisPoints(0)
    })
  })

  describe('refunds', () => {
    it('reduces net sales but keeps the cost of the food', async () => {
      await resetPeriod()
      const sessionId = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 1 },
      ])

      const payment = await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1000,
        tendered: 1000,
        idempotencyKey: key(),
      })
      await settleAndCloseSession(ctx(), sessionId)

      await issueRefund(ctx(), payment.paymentId, {
        amount: 1000,
        reason: 'Customer complaint',
        idempotencyKey: key(),
      })

      const report = await readSalesReport(reportCtx(), wholeWindow())

      /**
       * The point of the whole refund model. The bowl was cooked and is gone;
       * refunding the customer does not put the noodles back on the shelf, so
       * a fully refunded meal is a total loss rather than a sale that never
       * happened.
       */
      expect(report.summary.refundedMinor).toBe(1000)
      expect(report.summary.netSalesMinor).toBe(0)
      expect(report.summary.costMinor).toBe(100)
      expect(report.summary.grossProfitMinor).toBe(-100)
    })

    it('halves the tax on a half refund', async () => {
      await resetPeriod()
      await setTaxBasisPoints(1000)

      const sessionId = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 1 },
      ])
      const payment = await takePayment(ctx(), sessionId, {
        method: 'cash',
        amount: 1100,
        tendered: 1100,
        idempotencyKey: key(),
      })
      await settleAndCloseSession(ctx(), sessionId)

      await issueRefund(ctx(), payment.paymentId, {
        amount: 550,
        reason: 'One dish sent back',
        idempotencyKey: key(),
      })

      const report = await readTaxReport(reportCtx(), wholeWindow())

      // Half the bill came back, so half the tax collected on it did too.
      expect(report.totalTaxMinor).toBe(50)

      await setTaxBasisPoints(0)
    })
  })

  describe('item performance', () => {
    it('excludes a voided line from revenue', async () => {
      await resetPeriod()
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      const { lineIds } = await placeStaffOrder(ctx(), sessionId, {
        lines: [
          { menuItemId: costedItemId, quantity: 1, modifierSelections: [] },
          { menuItemId: uncostedItemId, quantity: 1, modifierSelections: [] },
        ],
      })

      await voidOrderLine(ctx(), lineIds[1], 'Ordered by mistake')
      await payAndClose(sessionId, 1000)

      const report = await readItemReport(reportCtx(), wholeWindow())

      expect(report.items.map((item) => item.name)).toEqual(['Laksa'])
      expect(report.items[0].revenueMinor).toBe(1000)
    })

    it('leaves an item with no recipe uncosted rather than free', async () => {
      await resetPeriod()
      const sessionId = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 1 },
        { menuItemId: uncostedItemId, quantity: 1 },
      ])
      await payAndClose(sessionId, 3000)

      const report = await readItemReport(reportCtx(), wholeWindow())
      const laksa = report.items.find((item) => item.name === 'Laksa')!
      const wine = report.items.find((item) => item.name === 'Wine')!

      expect(laksa.isCosted).toBe(true)
      expect(laksa.costMinor).toBe(100)
      expect(laksa.marginBasisPoints).toBe(9_000)

      /**
       * A zero cost would report a 100% margin on the wine, which is a claim
       * about the business rather than a gap in the data. Null says "nobody
       * has costed this" and the UI can say so out loud.
       */
      expect(wine.isCosted).toBe(false)
      expect(wine.marginBasisPoints).toBeNull()

      // RM 10 of RM 30 has a recipe behind it.
      expect(report.costCoverageBasisPoints).toBe(3_333)
    })

    it('reports coverage on the sales summary too', async () => {
      await resetPeriod()
      const sessionId = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 1 },
        { menuItemId: uncostedItemId, quantity: 1 },
      ])
      await payAndClose(sessionId, 3000)

      const report = await readSalesReport(reportCtx(), wholeWindow())

      // Without this the 96.7% margin below reads as a fact about the
      // restaurant rather than a fact about a third of its menu.
      expect(report.summary.costCoverageBasisPoints).toBe(3_333)
      expect(report.summary.marginBasisPoints).toBe(9_667)
    })
  })

  describe('what was given away', () => {
    it('gathers comps, voids and refunds into one figure', async () => {
      await resetPeriod()
      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      const { lineIds } = await placeStaffOrder(ctx(), sessionId, {
        lines: [
          { menuItemId: costedItemId, quantity: 1, modifierSelections: [] },
          { menuItemId: uncostedItemId, quantity: 1, modifierSelections: [] },
        ],
      })

      await voidOrderLine(ctx(), lineIds[1], 'Dropped')
      await applyDiscount(ctx(), sessionId, {
        type: 'fixed',
        value: 200,
        reason: 'Regular customer',
      })

      await payAndClose(sessionId, 800)

      const report = await readLossReport(reportCtx(), wholeWindow())

      expect(report.manualDiscounts).toHaveLength(1)
      expect(report.manualDiscounts[0].reason).toBe('Regular customer')
      expect(report.manualDiscounts[0].valueMinor).toBe(200)
      expect(report.manualDiscounts[0].appliedBy).toBe('Owner')

      expect(report.voids).toHaveLength(1)
      expect(report.voids[0].name).toBe('Wine')
      expect(report.voids[0].valueMinor).toBe(2000)

      expect(report.totalGivenAwayMinor).toBe(2200)
    })
  })

  describe('the trading day', () => {
    it('puts a bill settled after midnight in the night it belongs to', async () => {
      await resetPeriod()
      const sessionId = await sellAndSettle([
        { menuItemId: costedItemId, quantity: 1 },
      ])
      await payAndClose(sessionId, 1000)

      // Backdate the settlement to 01:30 local on the 8th.
      const lateNight = zonedTimeToInstant(KL, 2030, 8, 8, 90)
      await withTenant(ctx(), (tx) =>
        tx
          .update(salesRecords)
          .set({ settledAt: lateNight })
          .where(eq(salesRecords.restaurantId, restaurantId)),
      )

      const seventh = businessDayRange('2030-08-07', '2030-08-07', KL, 240)!
      const eighth = businessDayRange('2030-08-08', '2030-08-08', KL, 240)!

      const onSeventh = await readSalesReport(reportCtx(240), {
        range: seventh,
        branchId: null,
      })
      const onEighth = await readSalesReport(reportCtx(240), {
        range: eighth,
        branchId: null,
      })

      // With a 04:00 cutoff the night is one trading day, so a bill paid at
      // 01:30 counts towards the 7th — the service it was part of.
      expect(onSeventh.summary.bills).toBe(1)
      expect(onEighth.summary.bills).toBe(0)

      // At midnight it falls the other way, which is the honest answer for a
      // kitchen that closes at ten.
      const midnightEighth = businessDayRange(
        '2030-08-08',
        '2030-08-08',
        KL,
        0,
      )!
      const atMidnight = await readSalesReport(reportCtx(0), {
        range: midnightEighth,
        branchId: null,
      })
      expect(atMidnight.summary.bills).toBe(1)
    })
  })

  describe('live operations', () => {
    it('counts open bills and their value, and drops them once settled', async () => {
      await resetPeriod()
      const sessionId = await sellAndSettle(
        [{ menuItemId: costedItemId, quantity: 2 }],
        { guestCount: 3 },
      )

      const before = await readLiveOperations(reportCtx(), new Date(), branchId)
      expect(before.openBills).toBe(1)
      expect(before.seatedCovers).toBe(3)
      expect(before.openValueMinor).toBe(2000)
      // Two items still to cook.
      expect(before.kitchenQueue).toBe(1)

      await payAndClose(sessionId, 2000)

      const after = await readLiveOperations(reportCtx(), new Date(), branchId)
      expect(after.openBills).toBe(0)
      expect(after.openValueMinor).toBe(0)
      expect(after.settledBills).toBe(1)
      expect(after.netSalesTodayMinor).toBe(2000)
    })

    it('adds covers across tables rather than counting distinct sizes', async () => {
      await resetPeriod()

      const first = await sellAndSettle(
        [{ menuItemId: costedItemId, quantity: 1 }],
        { guestCount: 4 },
      )
      const second = await sellAndSettle(
        [{ menuItemId: costedItemId, quantity: 1 }],
        { guestCount: 4 },
      )

      const live = await readLiveOperations(reportCtx(), new Date(), branchId)

      // Eight, not four. Summing distinct values would be wrong every time
      // two parties happen to be the same size, which on a Friday is most.
      expect(live.seatedCovers).toBe(8)

      await payAndClose(first, 1000)
      await payAndClose(second, 1000)
    })
  })

  async function countRecords(): Promise<number> {
    const [row] = await withTenant(ctx(), (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(salesRecords)
        .where(eq(salesRecords.restaurantId, restaurantId)),
    )
    return row?.count ?? 0
  }
})
