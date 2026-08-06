import { and, asc, desc, eq, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  ingredients,
  purchaseOrderLines,
  purchaseOrders,
  stockLevels,
  suppliers,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { recordMovement } from './inventory.service'
import { weightedAverageCost, type StockUnit } from './stock'

/**
 * Suppliers and purchasing.
 *
 * A purchase order is the document; the stock movement is the fact. Receiving
 * is the only place the two meet, and it is the only place cost changes.
 */

// --- suppliers ---

export async function listSuppliers(
  restaurantId: string,
  userId: string,
): Promise<(typeof suppliers.$inferSelect)[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select()
      .from(suppliers)
      .where(eq(suppliers.restaurantId, restaurantId))
      .orderBy(asc(suppliers.name)),
  )
}

export interface CreateSupplierInput {
  name: string
  contactName?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  paymentTermDays: number
  notes?: string | null
}

export async function createSupplier(
  ctx: BranchActorContext,
  input: CreateSupplierInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [clash] = await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.restaurantId, ctx.restaurantId),
          eq(suppliers.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(`A supplier called "${input.name}" already exists.`)
    }

    const [created] = await tx
      .insert(suppliers)
      .values({
        restaurantId: ctx.restaurantId,
        name: input.name,
        contactName: input.contactName ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        paymentTermDays: input.paymentTermDays,
        notes: input.notes ?? null,
      })
      .returning({ id: suppliers.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'supplier.created',
      entityType: 'supplier',
      entityId: created.id,
      after: { name: input.name },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

// --- purchase orders ---

/**
 * Allocates the next reference for a restaurant.
 *
 * Derived from the count of existing orders inside the same transaction, so
 * two people raising an order at once cannot both take PO-000007 — the unique
 * index would reject the second, which is the intended outcome rather than a
 * crash to be avoided by guessing harder.
 */
async function nextReference(
  tx: Transaction,
  restaurantId: string,
): Promise<string> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.restaurantId, restaurantId))

  return `PO-${String((row?.count ?? 0) + 1).padStart(6, '0')}`
}

export interface PurchaseOrderLineInput {
  ingredientId: string
  orderedMilli: number
  unitCostMinor: number
}

export async function createPurchaseOrder(
  ctx: BranchActorContext,
  input: {
    branchId: string
    supplierId: string
    expectedAt?: Date | null
    notes?: string | null
    lines: PurchaseOrderLineInput[]
  },
): Promise<{ id: string; reference: string; totalMinor: number }> {
  if (input.lines.length === 0) {
    throw new ValidationError('A purchase order needs at least one line.')
  }

  const seen = new Set<string>()
  for (const line of input.lines) {
    if (line.orderedMilli <= 0) {
      throw new ValidationError('Each line needs a quantity above zero.')
    }
    if (line.unitCostMinor < 0) {
      throw new ValidationError('A unit cost cannot be negative.')
    }
    if (seen.has(line.ingredientId)) {
      throw new ValidationError(
        'The same ingredient appears twice. Combine the quantities into one line.',
      )
    }
    seen.add(line.ingredientId)
  }

  return withTenant(ctx, async (tx) => {
    const [supplier] = await tx
      .select({ id: suppliers.id, isActive: suppliers.isActive })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, input.supplierId),
          eq(suppliers.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!supplier) throw new NotFoundError('Supplier not found.')
    if (!supplier.isActive) {
      throw new ConflictError('That supplier is no longer active.')
    }

    const reference = await nextReference(tx, ctx.restaurantId)

    const [order] = await tx
      .insert(purchaseOrders)
      .values({
        restaurantId: ctx.restaurantId,
        branchId: input.branchId,
        supplierId: input.supplierId,
        reference,
        status: 'draft',
        expectedAt: input.expectedAt ?? null,
        notes: input.notes ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: purchaseOrders.id })

    let totalMinor = 0

    for (const line of input.lines) {
      const [ingredient] = await tx
        .select({
          id: ingredients.id,
          name: ingredients.name,
          unit: ingredients.unit,
        })
        .from(ingredients)
        .where(
          and(
            eq(ingredients.id, line.ingredientId),
            eq(ingredients.restaurantId, ctx.restaurantId),
          ),
        )
        .limit(1)

      if (!ingredient) throw new NotFoundError('Ingredient not found.')

      totalMinor += Math.round(
        (line.orderedMilli * line.unitCostMinor) / 1000,
      )

      await tx.insert(purchaseOrderLines).values({
        restaurantId: ctx.restaurantId,
        purchaseOrderId: order.id,
        ingredientId: ingredient.id,
        // Snapshotted: renaming an ingredient must not rewrite what a
        // delivered order says was bought.
        nameSnapshot: ingredient.name,
        unitSnapshot: ingredient.unit,
        orderedMilli: line.orderedMilli,
        unitCostMinor: line.unitCostMinor,
      })
    }

    await tx
      .update(purchaseOrders)
      .set({ totalMinor })
      .where(eq(purchaseOrders.id, order.id))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: order.id,
      after: { reference, totalMinor, lineCount: input.lines.length },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: order.id, reference, totalMinor }
  })
}

/**
 * Approves a purchase order, committing the restaurant to the spend.
 *
 * Refuses to let the person who raised it approve it. The separation is the
 * whole reason the permission exists — one person raising, authorising and
 * receiving their own order is how invoices for deliveries nobody saw get
 * paid, and enforcing it only in the UI enforces it not at all.
 */
export async function approvePurchaseOrder(
  ctx: BranchActorContext,
  purchaseOrderId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [order] = await tx
      .select({
        id: purchaseOrders.id,
        status: purchaseOrders.status,
        reference: purchaseOrders.reference,
        createdByUserId: purchaseOrders.createdByUserId,
      })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.id, purchaseOrderId),
          eq(purchaseOrders.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!order) throw new NotFoundError('Purchase order not found.')
    if (order.status !== 'draft') {
      throw new ConflictError(
        `${order.reference} is ${order.status.replace('_', ' ')} and cannot be approved again.`,
      )
    }
    if (order.createdByUserId === ctx.userId) {
      throw new ConflictError(
        'A purchase order must be approved by someone other than the person who raised it.',
      )
    }

    await tx
      .update(purchaseOrders)
      .set({
        status: 'approved',
        approvedByUserId: ctx.userId,
        approvedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, purchaseOrderId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'purchase_order.approved',
      entityType: 'purchase_order',
      entityId: purchaseOrderId,
      after: { reference: order.reference },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function cancelPurchaseOrder(
  ctx: BranchActorContext,
  purchaseOrderId: string,
  reason: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [order] = await tx
      .select({
        status: purchaseOrders.status,
        reference: purchaseOrders.reference,
      })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.id, purchaseOrderId),
          eq(purchaseOrders.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!order) throw new NotFoundError('Purchase order not found.')

    /**
     * Partially received orders can still be cancelled — a supplier who
     * delivers half and then folds is a real situation, and the stock already
     * received stays received. What cannot be cancelled is an order that is
     * complete, because there is nothing left to call off.
     */
    if (order.status === 'received' || order.status === 'cancelled') {
      throw new ConflictError(
        `${order.reference} is already ${order.status} and cannot be cancelled.`,
      )
    }

    await tx
      .update(purchaseOrders)
      .set({ status: 'cancelled', cancelledAt: new Date(), notes: reason })
      .where(eq(purchaseOrders.id, purchaseOrderId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'purchase_order.cancelled',
      entityType: 'purchase_order',
      entityId: purchaseOrderId,
      after: { reference: order.reference, reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export interface ReceiptLineInput {
  purchaseOrderLineId: string
  receivedMilli: number
  /** Overrides the ordered price when the invoice differs. */
  unitCostMinor?: number
}

export interface ReceiptResult {
  status: 'partially_received' | 'received'
  received: { ingredientId: string; name: string; receivedMilli: number }[]
}

/**
 * Receives goods against a purchase order.
 *
 * Partial receipts are the normal case, not the exception — suppliers short
 * a case, substitute a size, deliver over two days. Modelling receipt as
 * all-or-nothing would mean the first short delivery forces someone to lie in
 * one direction or the other.
 *
 * Receiving is the only operation that changes an ingredient's held cost,
 * because it is the only moment the restaurant learns what the stock actually
 * cost. The new cost is a weighted average of what was already on hand and
 * what just arrived.
 */
export async function receiveGoods(
  ctx: BranchActorContext,
  purchaseOrderId: string,
  lines: ReceiptLineInput[],
): Promise<ReceiptResult> {
  if (lines.length === 0) {
    throw new ValidationError('Enter what was received.')
  }

  return withTenant(ctx, async (tx) => {
    const [order] = await tx
      .select({
        id: purchaseOrders.id,
        status: purchaseOrders.status,
        branchId: purchaseOrders.branchId,
        reference: purchaseOrders.reference,
      })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.id, purchaseOrderId),
          eq(purchaseOrders.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!order) throw new NotFoundError('Purchase order not found.')

    if (order.status === 'draft') {
      throw new ConflictError(
        `${order.reference} has not been approved yet, so goods cannot be received against it.`,
      )
    }
    if (order.status === 'cancelled') {
      throw new ConflictError(`${order.reference} was cancelled.`)
    }
    if (order.status === 'received') {
      throw new ConflictError(`${order.reference} is already fully received.`)
    }

    const received: ReceiptResult['received'] = []

    for (const input of lines) {
      if (input.receivedMilli <= 0) continue

      const [line] = await tx
        .select({
          id: purchaseOrderLines.id,
          ingredientId: purchaseOrderLines.ingredientId,
          nameSnapshot: purchaseOrderLines.nameSnapshot,
          orderedMilli: purchaseOrderLines.orderedMilli,
          receivedMilli: purchaseOrderLines.receivedMilli,
          unitCostMinor: purchaseOrderLines.unitCostMinor,
        })
        .from(purchaseOrderLines)
        .where(
          and(
            eq(purchaseOrderLines.id, input.purchaseOrderLineId),
            eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
          ),
        )
        .limit(1)

      if (!line) throw new NotFoundError('Purchase order line not found.')

      /**
       * Over-receipt is refused rather than silently absorbed. A delivery
       * larger than the order is either a supplier error or a typo, and both
       * want a human looking at them before the stock and the payable move.
       */
      if (line.receivedMilli + input.receivedMilli > line.orderedMilli) {
        const outstanding = line.orderedMilli - line.receivedMilli
        throw new ConflictError(
          `${line.nameSnapshot}: only ${outstanding / 1000} outstanding, but ${input.receivedMilli / 1000} was entered.`,
        )
      }

      const unitCostMinor = input.unitCostMinor ?? line.unitCostMinor

      const [level] = await tx
        .select({ quantityMilli: stockLevels.quantityMilli })
        .from(stockLevels)
        .where(
          and(
            eq(stockLevels.branchId, order.branchId),
            eq(stockLevels.ingredientId, line.ingredientId),
          ),
        )
        .limit(1)

      const [ingredient] = await tx
        .select({ costPerUnitMinor: ingredients.costPerUnitMinor })
        .from(ingredients)
        .where(eq(ingredients.id, line.ingredientId))
        .limit(1)

      const newCost = weightedAverageCost({
        onHandMilli: level?.quantityMilli ?? 0,
        currentCostPerUnitMinor: ingredient?.costPerUnitMinor ?? 0,
        receivedMilli: input.receivedMilli,
        receivedCostPerUnitMinor: unitCostMinor,
      })

      /**
       * The movement is costed at the price actually paid, not at the new
       * average. The average is what the *remaining* stock is worth; this
       * delivery is worth what the invoice says.
       */
      await recordMovement(
        tx,
        ctx.restaurantId,
        {
          branchId: order.branchId,
          ingredientId: line.ingredientId,
          kind: 'receipt',
          quantityMilli: input.receivedMilli,
          costPerUnitMinor: unitCostMinor,
          reason: `Received against ${order.reference}`,
          purchaseOrderId,
        },
        ctx.userId,
      )

      await tx
        .update(ingredients)
        .set({ costPerUnitMinor: newCost })
        .where(eq(ingredients.id, line.ingredientId))

      await tx
        .update(purchaseOrderLines)
        .set({
          receivedMilli: sql`${purchaseOrderLines.receivedMilli} + ${input.receivedMilli}`,
        })
        .where(eq(purchaseOrderLines.id, line.id))

      received.push({
        ingredientId: line.ingredientId,
        name: line.nameSnapshot,
        receivedMilli: input.receivedMilli,
      })
    }

    const outstanding = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
          sql`${purchaseOrderLines.receivedMilli} < ${purchaseOrderLines.orderedMilli}`,
        ),
      )

    const status =
      (outstanding[0]?.count ?? 0) > 0 ? 'partially_received' : 'received'

    await tx
      .update(purchaseOrders)
      .set({ status })
      .where(eq(purchaseOrders.id, purchaseOrderId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'purchase_order.received',
      entityType: 'purchase_order',
      entityId: purchaseOrderId,
      after: { reference: order.reference, status, received },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { status, received }
  })
}

export interface PurchaseOrderSummary {
  id: string
  reference: string
  status: 'draft' | 'approved' | 'partially_received' | 'received' | 'cancelled'
  supplierName: string
  totalMinor: number
  expectedAt: Date | null
  createdAt: Date
}

export async function listPurchaseOrders(
  restaurantId: string,
  userId: string,
  branchId?: string,
): Promise<PurchaseOrderSummary[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: purchaseOrders.id,
        reference: purchaseOrders.reference,
        status: purchaseOrders.status,
        supplierName: suppliers.name,
        totalMinor: purchaseOrders.totalMinor,
        expectedAt: purchaseOrders.expectedAt,
        createdAt: purchaseOrders.createdAt,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
      .where(
        and(
          eq(purchaseOrders.restaurantId, restaurantId),
          branchId ? eq(purchaseOrders.branchId, branchId) : undefined,
        ),
      )
      .orderBy(desc(purchaseOrders.createdAt)),
  )
}

export interface PurchaseOrderDetail extends PurchaseOrderSummary {
  branchId: string
  notes: string | null
  lines: {
    id: string
    ingredientId: string
    name: string
    unit: StockUnit
    orderedMilli: number
    receivedMilli: number
    unitCostMinor: number
  }[]
}

export async function readPurchaseOrder(
  restaurantId: string,
  userId: string,
  purchaseOrderId: string,
): Promise<PurchaseOrderDetail> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const [order] = await tx
      .select({
        id: purchaseOrders.id,
        reference: purchaseOrders.reference,
        status: purchaseOrders.status,
        supplierName: suppliers.name,
        totalMinor: purchaseOrders.totalMinor,
        expectedAt: purchaseOrders.expectedAt,
        createdAt: purchaseOrders.createdAt,
        branchId: purchaseOrders.branchId,
        notes: purchaseOrders.notes,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
      .where(
        and(
          eq(purchaseOrders.id, purchaseOrderId),
          eq(purchaseOrders.restaurantId, restaurantId),
        ),
      )
      .limit(1)

    if (!order) throw new NotFoundError('Purchase order not found.')

    const lines = await tx
      .select({
        id: purchaseOrderLines.id,
        ingredientId: purchaseOrderLines.ingredientId,
        name: purchaseOrderLines.nameSnapshot,
        unit: purchaseOrderLines.unitSnapshot,
        orderedMilli: purchaseOrderLines.orderedMilli,
        receivedMilli: purchaseOrderLines.receivedMilli,
        unitCostMinor: purchaseOrderLines.unitCostMinor,
      })
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
      .orderBy(asc(purchaseOrderLines.nameSnapshot))

    return { ...order, lines }
  })
}
