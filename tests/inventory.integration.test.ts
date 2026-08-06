import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import {
  branches,
  ingredients,
  restaurants,
  stockLevels,
  users,
} from '@/lib/db/schema'
import { ConflictError } from '@/lib/errors'
import {
  createIngredient,
  listStock,
  reconcileStock,
  recordCount,
  recordWastage,
  setRecipe,
  transferStock,
} from '@/modules/inventory/inventory.service'
import {
  approvePurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  readPurchaseOrder,
  receiveGoods,
} from '@/modules/inventory/purchasing.service'
import { createItem } from '@/modules/menu/item.service'
import {
  openTakeawaySession,
  placeStaffOrder,
} from '@/modules/pos/pos.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { voidOrderLine } from '@/modules/session/order.service'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'

/**
 * Inventory against a real database.
 *
 * The arithmetic is unit-tested in stock.test.ts. What needs a database is
 * that an order actually moves stock, that a void puts it back, that partial
 * receipts advance a purchase order without completing it, that receiving
 * re-averages cost, and — most importantly — that the cached level and the
 * ledger never disagree.
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

describe.skipIf(!enabled)('inventory', () => {
  let restaurantId: string
  let ownerId: string
  let approverId: string
  let branchId: string
  let otherBranchId: string

  const ctx = () => ({ restaurantId, userId: ownerId })
  const approver = () => ({ restaurantId, userId: approverId })

  async function makeIngredient(
    unit: 'kg' | 'l' | 'each' = 'kg',
    costPerUnitMinor = 1000,
  ): Promise<string> {
    const { id } = await createIngredient(ctx(), {
      name: `Ingredient ${randomUUID().slice(0, 8)}`,
      unit,
      costPerUnitMinor,
      reorderPointMilli: 0,
      reorderQuantityMilli: 0,
    })
    return id
  }

  async function levelOf(
    ingredientId: string,
    atBranch = branchId,
  ): Promise<number> {
    const rows = await withTenant(ctx(), (tx) =>
      tx
        .select({
          branchId: stockLevels.branchId,
          quantityMilli: stockLevels.quantityMilli,
        })
        .from(stockLevels)
        .where(eq(stockLevels.ingredientId, ingredientId)),
    )

    return rows.find((row) => row.branchId === atBranch)?.quantityMilli ?? 0
  }

  /** Seeds a branch with a known quantity, via a count. */
  async function stockUp(
    ingredientId: string,
    quantityMilli: number,
    atBranch = branchId,
  ): Promise<void> {
    await recordCount(ctx(), atBranch, ingredientId, quantityMilli, 'Opening')
  }

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `inv-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    const [second] = await db
      .insert(users)
      .values({ email: `inv-approve-${s}@test.local`, name: 'Approver' })
      .returning({ id: users.id })
    approverId = second.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `Inv ${s}`))
    ).restaurantId

    const created = await withTenant(ctx(), (tx) =>
      tx
        .insert(branches)
        .values([
          { restaurantId, name: 'Main', code: 'M1' },
          { restaurantId, name: 'Second', code: 'M2' },
        ])
        .returning({ id: branches.id }),
    )
    branchId = created[0].id
    otherBranchId = created[1].id
  })

  afterAll(async () => {
    await withTenant(ctx(), (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, restaurantId)),
    )
    await db.delete(users).where(eq(users.id, ownerId))
    await db.delete(users).where(eq(users.id, approverId))
  })

  describe('counting and wastage', () => {
    it('sets the level to what was counted, not to a delta', async () => {
      const ingredientId = await makeIngredient()

      const first = await recordCount(ctx(), branchId, ingredientId, 4000)
      expect(first.adjustmentMilli).toBe(4000)
      expect(await levelOf(ingredientId)).toBe(4000)

      // Counting 3 kg when the books say 4 kg is a 1 kg correction, not a
      // 3 kg one. Asking a person with a clipboard to work that out is where
      // the mistakes come from, so the service does it.
      const second = await recordCount(ctx(), branchId, ingredientId, 3000)
      expect(second.adjustmentMilli).toBe(-1000)
      expect(await levelOf(ingredientId)).toBe(3000)
    })

    it('records a count that found no discrepancy', async () => {
      const ingredientId = await makeIngredient()
      await stockUp(ingredientId, 2000)

      const result = await recordCount(ctx(), branchId, ingredientId, 2000)

      expect(result.adjustmentMilli).toBe(0)

      const [row] = await listStock(restaurantId, ownerId, branchId).then(
        (rows) => rows.filter((r) => r.ingredientId === ingredientId),
      )

      // "Counted, and it was right" is a fact worth keeping — without it the
      // shelf looks like it was never checked.
      expect(row.lastCountedAt).not.toBeNull()
    })

    it('takes wastage off the shelf', async () => {
      const ingredientId = await makeIngredient()
      await stockUp(ingredientId, 5000)

      await recordWastage(ctx(), branchId, ingredientId, 500, 'Dropped')

      expect(await levelOf(ingredientId)).toBe(4500)
    })

    it('allows wastage to take a level negative rather than refusing', async () => {
      const ingredientId = await makeIngredient()
      await stockUp(ingredientId, 100)

      await recordWastage(ctx(), branchId, ingredientId, 500, 'Spoiled')

      // The bin does not care what the system believed. Refusing would mean
      // the write-off never gets recorded at all.
      expect(await levelOf(ingredientId)).toBe(-400)
    })
  })

  describe('transfers', () => {
    it('moves stock between branches as two movements', async () => {
      const ingredientId = await makeIngredient()
      await stockUp(ingredientId, 5000)

      await transferStock(ctx(), branchId, otherBranchId, ingredientId, 2000)

      expect(await levelOf(ingredientId, branchId)).toBe(3000)
      expect(await levelOf(ingredientId, otherBranchId)).toBe(2000)
    })

    it('refuses a transfer to the same branch', async () => {
      const ingredientId = await makeIngredient()

      await expect(
        transferStock(ctx(), branchId, branchId, ingredientId, 100),
      ).rejects.toThrow(/different branches/i)
    })
  })

  describe('deduction on order', () => {
    it('consumes a recipe when an order is placed', async () => {
      const beef = await makeIngredient('kg')
      const bun = await makeIngredient('each')
      await stockUp(beef, 5000)
      await stockUp(bun, 20000)

      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: `Burger ${randomUUID().slice(0, 6)}`,
        price: 1500,
      })

      await setRecipe(ctx(), { menuItemId: item.id }, [
        { ingredientId: beef, quantityMilli: 150 },
        { ingredientId: bun, quantityMilli: 1000 },
      ])

      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: item.id, quantity: 3, modifierSelections: [] }],
      })

      expect(await levelOf(beef)).toBe(5000 - 450)
      expect(await levelOf(bun)).toBe(20000 - 3000)
    })

    it('reports a shortfall without refusing the order', async () => {
      const saffron = await makeIngredient('kg')
      await stockUp(saffron, 1)

      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: `Paella ${randomUUID().slice(0, 6)}`,
        price: 4000,
      })

      await setRecipe(ctx(), { menuItemId: item.id }, [
        { ingredientId: saffron, quantityMilli: 10 },
      ])

      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      const result = await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: item.id, quantity: 1, modifierSelections: [] }],
      })

      /**
       * The order goes through. A kitchen that has run out mid-service
       * substitutes or tells the table; if the POS refused, the workaround
       * would be to stop recording stock entirely.
       */
      expect(result.lineIds).toHaveLength(1)
      expect(result.shortfalls).toHaveLength(1)
      expect(result.shortfalls[0].shortMilli).toBe(9)
      expect(await levelOf(saffron)).toBe(-9)
    })

    it('returns stock when a line is voided', async () => {
      const cheese = await makeIngredient('kg')
      await stockUp(cheese, 2000)

      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: `Toastie ${randomUUID().slice(0, 6)}`,
        price: 900,
      })

      await setRecipe(ctx(), { menuItemId: item.id }, [
        { ingredientId: cheese, quantityMilli: 50 },
      ])

      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      const { lineIds } = await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: item.id, quantity: 2, modifierSelections: [] }],
      })

      expect(await levelOf(cheese)).toBe(1900)

      await voidOrderLine(ctx(), lineIds[0], 'Wrong order')

      expect(await levelOf(cheese)).toBe(2000)
    })

    it('deducts nothing for an item with no recipe', async () => {
      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: `Bottled water ${randomUUID().slice(0, 6)}`,
        price: 300,
      })

      const { sessionId } = await openTakeawaySession(ctx(), {
        type: 'takeaway',
        branchId,
      })

      const result = await placeStaffOrder(ctx(), sessionId, {
        lines: [{ menuItemId: item.id, quantity: 5, modifierSelections: [] }],
      })

      expect(result.shortfalls).toEqual([])
    })
  })

  describe('purchase orders', () => {
    async function makeSupplier(): Promise<string> {
      const { id } = await createSupplier(ctx(), {
        name: `Supplier ${randomUUID().slice(0, 8)}`,
        paymentTermDays: 30,
      })
      return id
    }

    it('refuses approval by the person who raised it', async () => {
      const supplierId = await makeSupplier()
      const ingredientId = await makeIngredient()

      const order = await createPurchaseOrder(ctx(), {
        branchId,
        supplierId,
        lines: [{ ingredientId, orderedMilli: 5000, unitCostMinor: 1200 }],
      })

      /**
       * The separation is the whole reason the permission exists. Enforcing
       * it only in the UI enforces it not at all.
       */
      await expect(approvePurchaseOrder(ctx(), order.id)).rejects.toBeInstanceOf(
        ConflictError,
      )

      await approvePurchaseOrder(approver(), order.id)

      const read = await readPurchaseOrder(restaurantId, ownerId, order.id)
      expect(read.status).toBe('approved')
    })

    it('computes the order total from quantity and unit cost', async () => {
      const supplierId = await makeSupplier()
      const ingredientId = await makeIngredient()

      // 5 kg at RM 12.00 is RM 60.00.
      const order = await createPurchaseOrder(ctx(), {
        branchId,
        supplierId,
        lines: [{ ingredientId, orderedMilli: 5000, unitCostMinor: 1200 }],
      })

      expect(order.totalMinor).toBe(6000)
      expect(order.reference).toMatch(/^PO-\d{6}$/)
    })

    it('refuses to receive against a draft', async () => {
      const supplierId = await makeSupplier()
      const ingredientId = await makeIngredient()

      const order = await createPurchaseOrder(ctx(), {
        branchId,
        supplierId,
        lines: [{ ingredientId, orderedMilli: 5000, unitCostMinor: 1200 }],
      })

      const detail = await readPurchaseOrder(restaurantId, ownerId, order.id)

      await expect(
        receiveGoods(ctx(), order.id, [
          { purchaseOrderLineId: detail.lines[0].id, receivedMilli: 5000 },
        ]),
      ).rejects.toThrow(/not been approved/i)
    })

    it('records a partial delivery and leaves the order open', async () => {
      const supplierId = await makeSupplier()
      const ingredientId = await makeIngredient()

      const order = await createPurchaseOrder(ctx(), {
        branchId,
        supplierId,
        lines: [{ ingredientId, orderedMilli: 5000, unitCostMinor: 1200 }],
      })
      await approvePurchaseOrder(approver(), order.id)

      const detail = await readPurchaseOrder(restaurantId, ownerId, order.id)

      const first = await receiveGoods(ctx(), order.id, [
        { purchaseOrderLineId: detail.lines[0].id, receivedMilli: 3000 },
      ])

      expect(first.status).toBe('partially_received')
      expect(await levelOf(ingredientId)).toBe(3000)

      const second = await receiveGoods(ctx(), order.id, [
        { purchaseOrderLineId: detail.lines[0].id, receivedMilli: 2000 },
      ])

      expect(second.status).toBe('received')
      expect(await levelOf(ingredientId)).toBe(5000)
    })

    it('refuses to receive more than was ordered', async () => {
      const supplierId = await makeSupplier()
      const ingredientId = await makeIngredient()

      const order = await createPurchaseOrder(ctx(), {
        branchId,
        supplierId,
        lines: [{ ingredientId, orderedMilli: 5000, unitCostMinor: 1200 }],
      })
      await approvePurchaseOrder(approver(), order.id)

      const detail = await readPurchaseOrder(restaurantId, ownerId, order.id)

      // A delivery larger than the order is a supplier error or a typo, and
      // both want a human looking before stock and the payable move.
      await expect(
        receiveGoods(ctx(), order.id, [
          { purchaseOrderLineId: detail.lines[0].id, receivedMilli: 6000 },
        ]),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('re-averages the held cost on receipt', async () => {
      const supplierId = await makeSupplier()
      const ingredientId = await makeIngredient('kg', 1000)
      await stockUp(ingredientId, 1000) // 1 kg on hand at RM 10.00

      const order = await createPurchaseOrder(ctx(), {
        branchId,
        supplierId,
        lines: [{ ingredientId, orderedMilli: 3000, unitCostMinor: 1400 }],
      })
      await approvePurchaseOrder(approver(), order.id)

      const detail = await readPurchaseOrder(restaurantId, ownerId, order.id)
      await receiveGoods(ctx(), order.id, [
        { purchaseOrderLineId: detail.lines[0].id, receivedMilli: 3000 },
      ])

      const [ingredient] = await withTenant(ctx(), (tx) =>
        tx
          .select({ costPerUnitMinor: ingredients.costPerUnitMinor })
          .from(ingredients)
          .where(eq(ingredients.id, ingredientId)),
      )

      // 1 kg at RM 10 plus 3 kg at RM 14 is RM 13/kg, not RM 12.
      expect(ingredient.costPerUnitMinor).toBe(1300)
    })

    it('takes the invoice price over the ordered price', async () => {
      const supplierId = await makeSupplier()
      const ingredientId = await makeIngredient('kg', 0)

      const order = await createPurchaseOrder(ctx(), {
        branchId,
        supplierId,
        lines: [{ ingredientId, orderedMilli: 2000, unitCostMinor: 1000 }],
      })
      await approvePurchaseOrder(approver(), order.id)

      const detail = await readPurchaseOrder(restaurantId, ownerId, order.id)
      await receiveGoods(ctx(), order.id, [
        {
          purchaseOrderLineId: detail.lines[0].id,
          receivedMilli: 2000,
          unitCostMinor: 1150,
        },
      ])

      const [ingredient] = await withTenant(ctx(), (tx) =>
        tx
          .select({ costPerUnitMinor: ingredients.costPerUnitMinor })
          .from(ingredients)
          .where(eq(ingredients.id, ingredientId)),
      )

      // Prices move between order and delivery. The invoice is what was paid.
      expect(ingredient.costPerUnitMinor).toBe(1150)
    })
  })

  describe('the cache and the ledger', () => {
    it('never drift across a service worth of movements', async () => {
      const beef = await makeIngredient('kg')
      const bun = await makeIngredient('each')
      const supplierId = await createSupplier(ctx(), {
        name: `Supplier ${randomUUID().slice(0, 8)}`,
        paymentTermDays: 0,
      }).then((s) => s.id)

      const item = await createItem(ctx(), {
        ...ITEM_BASE,
        name: `Burger ${randomUUID().slice(0, 6)}`,
        price: 1500,
      })
      await setRecipe(ctx(), { menuItemId: item.id }, [
        { ingredientId: beef, quantityMilli: 150 },
        { ingredientId: bun, quantityMilli: 1000 },
      ])

      // A delivery.
      const order = await createPurchaseOrder(ctx(), {
        branchId,
        supplierId,
        lines: [
          { ingredientId: beef, orderedMilli: 10000, unitCostMinor: 3000 },
          { ingredientId: bun, orderedMilli: 50000, unitCostMinor: 50 },
        ],
      })
      await approvePurchaseOrder(approver(), order.id)
      const detail = await readPurchaseOrder(restaurantId, ownerId, order.id)
      await receiveGoods(
        ctx(),
        order.id,
        detail.lines.map((line) => ({
          purchaseOrderLineId: line.id,
          receivedMilli: line.orderedMilli,
        })),
      )

      // A service.
      for (let i = 0; i < 5; i += 1) {
        const { sessionId } = await openTakeawaySession(ctx(), {
          type: 'takeaway',
          branchId,
        })
        const { lineIds } = await placeStaffOrder(ctx(), sessionId, {
          lines: [{ menuItemId: item.id, quantity: 2, modifierSelections: [] }],
        })

        if (i === 3) await voidOrderLine(ctx(), lineIds[0], 'Sent back')
      }

      // A mishap, a count and a transfer.
      await recordWastage(ctx(), branchId, beef, 300, 'Burnt')
      await recordCount(ctx(), branchId, bun, 44000)
      await transferStock(ctx(), branchId, otherBranchId, beef, 1000)

      const drift = await reconcileStock(restaurantId, ownerId, branchId)

      /**
       * The cached level exists for speed, and a cache nobody checks is a
       * cache nobody can trust. This is what makes it defensible rather than
       * merely convenient — every write path goes through `recordMovement`,
       * and this proves it.
       */
      expect(drift).toEqual([])
    })

    it('reports drift when the cache is corrupted behind its back', async () => {
      const ingredientId = await makeIngredient()
      await stockUp(ingredientId, 5000)

      expect(await reconcileStock(restaurantId, ownerId, branchId)).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ ingredientId }),
        ]),
      )

      /**
       * Writes the level directly, bypassing `recordMovement` — exactly what
       * a second write path would do. Without this the test above could pass
       * because `reconcileStock` never reports anything, which would be a
       * guard that guards nothing.
       */
      await withTenant(ctx(), (tx) =>
        tx
          .update(stockLevels)
          .set({ quantityMilli: 9999 })
          .where(eq(stockLevels.ingredientId, ingredientId)),
      )

      const drift = await reconcileStock(restaurantId, ownerId, branchId)

      expect(drift).toContainEqual({
        ingredientId,
        cachedMilli: 9999,
        ledgerMilli: 5000,
      })
    })
  })
})
