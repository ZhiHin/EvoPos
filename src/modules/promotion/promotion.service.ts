import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  diningSessions,
  menuItems,
  orderLines,
  promotionRedemptions,
  promotions,
  vouchers,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import {
  evaluatePromotions,
  type BillContext,
  type EvaluationResult,
  type PromotionDefinition,
} from './engine'

/**
 * Promotions against live bills.
 *
 * Loads definitions, builds the bill context, hands both to the pure engine,
 * and records what fired. The engine decides; this module only supplies facts
 * and persists outcomes.
 */

function toDefinition(row: typeof promotions.$inferSelect): PromotionDefinition {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    value: row.value,
    priority: row.priority,
    isStackable: row.isStackable,
    usageRemaining:
      row.maxUsageTotal === null
        ? null
        : Math.max(0, row.maxUsageTotal - row.usageCount),
    conditions: {
      validFrom: row.validFrom,
      validTo: row.validTo,
      daysOfWeek: row.daysOfWeek,
      startTime: row.startTime,
      endTime: row.endTime,
      branchIds: row.branchIds,
      minSpendMinor: row.minSpendMinor,
      categoryIds: row.categoryIds,
      menuItemIds: row.menuItemIds,
      minQuantity: row.minQuantity,
      requiredTierId: row.requiredTierId,
      requiresVoucher: row.requiresVoucher,
    },
  }
}

export async function listPromotions(
  restaurantId: string,
  userId: string,
): Promise<(typeof promotions.$inferSelect)[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select()
      .from(promotions)
      .where(eq(promotions.restaurantId, restaurantId))
      .orderBy(asc(promotions.priority), asc(promotions.name)),
  )
}

/**
 * Builds the bill context the engine needs.
 *
 * `unitPriceMinor` comes from the frozen line, not from the current menu — a
 * BOGO computed against a price that has since changed would discount an
 * amount the customer never saw.
 */
async function buildBillContext(
  tx: Transaction,
  sessionId: string,
  unlockedPromotionIds: string[],
  customerTierId: string | null,
  now: Date,
): Promise<BillContext> {
  const [session] = await tx
    .select({ branchId: diningSessions.branchId })
    .from(diningSessions)
    .where(eq(diningSessions.id, sessionId))
    .limit(1)

  if (!session) throw new NotFoundError('Session not found.')

  const lines = await tx
    .select({
      lineId: orderLines.id,
      menuItemId: orderLines.menuItemId,
      categoryId: menuItems.categoryId,
      quantity: orderLines.quantity,
      unitPriceMinor: orderLines.unitPriceMinor,
      lineTotalMinor: orderLines.lineTotalMinor,
    })
    .from(orderLines)
    .leftJoin(menuItems, eq(menuItems.id, orderLines.menuItemId))
    .where(
      and(eq(orderLines.sessionId, sessionId), ne(orderLines.status, 'voided')),
    )

  return {
    now,
    branchId: session.branchId,
    subtotalMinor: lines.reduce((sum, l) => sum + l.lineTotalMinor, 0),
    lines,
    customerTierId,
    unlockedPromotionIds,
  }
}

/** Promotions already unlocked on this bill by a redeemed voucher. */
async function unlockedFor(
  tx: Transaction,
  sessionId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ promotionId: promotionRedemptions.promotionId })
    .from(promotionRedemptions)
    .where(
      and(
        eq(promotionRedemptions.sessionId, sessionId),
        // A redemption row with no promotion means it was deleted since.
        sql`${promotionRedemptions.promotionId} is not null`,
      ),
    )

  return rows.map((r) => r.promotionId!).filter(Boolean)
}

/**
 * Works out which promotions would apply, without changing anything.
 *
 * Safe to call on every bill view, which is the point — a cashier should see
 * "10% member discount will apply" before the customer is asked to pay, not
 * discover it afterwards.
 */
export async function previewPromotions(
  restaurantId: string,
  userId: string,
  sessionId: string,
  customerTierId: string | null = null,
  now: Date = new Date(),
): Promise<EvaluationResult> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const definitions = await tx
      .select()
      .from(promotions)
      .where(
        and(
          eq(promotions.restaurantId, restaurantId),
          eq(promotions.isActive, true),
        ),
      )

    const context = await buildBillContext(
      tx,
      sessionId,
      await unlockedFor(tx, sessionId),
      customerTierId,
      now,
    )

    return evaluatePromotions(definitions.map(toDefinition), context)
  })
}

/**
 * Claims one use of a promotion.
 *
 * A conditional UPDATE, not a read-then-write. Two tills redeeming the last
 * use of a promotion at the same instant would both pass a read check and
 * both write, taking the count to 101 of 100. Here exactly one UPDATE matches
 * the row and the other gets nothing back.
 */
async function claimUsage(
  tx: Transaction,
  promotionId: string,
): Promise<boolean> {
  const claimed = await tx
    .update(promotions)
    .set({ usageCount: sql`${promotions.usageCount} + 1` })
    .where(
      and(
        eq(promotions.id, promotionId),
        or(
          isNull(promotions.maxUsageTotal),
          sql`${promotions.usageCount} < ${promotions.maxUsageTotal}`,
        ),
      ),
    )
    .returning({ id: promotions.id })

  return claimed.length > 0
}

export interface AppliedPromotionRecord {
  promotionId: string
  name: string
  discountMinor: number
}

/**
 * Applies promotions to a bill and records what fired.
 *
 * Re-evaluates rather than trusting anything the client sends — a discount
 * arriving from a browser is a request, not a fact, exactly as a price is.
 *
 * Existing automatic redemptions are cleared first so re-applying after an
 * order changes does not stack the same promotion twice.
 */
export async function applyPromotions(
  ctx: BranchActorContext,
  sessionId: string,
  customerId: string | null = null,
  customerTierId: string | null = null,
): Promise<AppliedPromotionRecord[]> {
  return withTenant(ctx, async (tx) => {
    const definitions = await tx
      .select()
      .from(promotions)
      .where(
        and(
          eq(promotions.restaurantId, ctx.restaurantId),
          eq(promotions.isActive, true),
        ),
      )

    const context = await buildBillContext(
      tx,
      sessionId,
      await unlockedFor(tx, sessionId),
      customerTierId,
      new Date(),
    )

    const result = evaluatePromotions(definitions.map(toDefinition), context)

    /**
     * Voucher-unlocked redemptions survive. Clearing them would release the
     * voucher's hold on this bill while its redemption count stays spent.
     */
    await tx
      .delete(promotionRedemptions)
      .where(
        and(
          eq(promotionRedemptions.sessionId, sessionId),
          isNull(promotionRedemptions.voucherId),
        ),
      )

    const recorded: AppliedPromotionRecord[] = []

    for (const applied of result.applied) {
      if (!(await claimUsage(tx, applied.promotionId))) {
        // Someone took the last use between evaluation and now. Skipping is
        // correct: the customer simply does not get that one.
        continue
      }

      await tx.insert(promotionRedemptions).values({
        restaurantId: ctx.restaurantId,
        sessionId,
        promotionId: applied.promotionId,
        customerId,
        nameSnapshot: applied.name,
        discountMinor: applied.discountMinor,
      })

      recorded.push({
        promotionId: applied.promotionId,
        name: applied.name,
        discountMinor: applied.discountMinor,
      })
    }

    if (recorded.length > 0) {
      await recordAuditIn(tx, {
        restaurantId: ctx.restaurantId,
        actorUserId: ctx.userId,
        action: 'promotion.applied',
        entityType: 'dining_session',
        entityId: sessionId,
        after: { promotions: recorded },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      })
    }

    return recorded
  })
}

/**
 * Redeems a voucher code against a bill.
 *
 * The code unlocks its promotion; the promotion still has to qualify on its
 * own terms. A voucher is permission to be considered, not a guarantee of a
 * discount — otherwise a minimum-spend coupon would pay out on any bill.
 */
export async function redeemVoucher(
  ctx: BranchActorContext,
  sessionId: string,
  rawCode: string,
): Promise<{ promotionName: string; discountMinor: number }> {
  const code = rawCode.trim().toUpperCase()

  return withTenant(ctx, async (tx) => {
    const [voucher] = await tx
      .select({
        id: vouchers.id,
        promotionId: vouchers.promotionId,
        maxRedemptions: vouchers.maxRedemptions,
        redemptionCount: vouchers.redemptionCount,
        expiresAt: vouchers.expiresAt,
        isActive: vouchers.isActive,
        customerId: vouchers.customerId,
      })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.restaurantId, ctx.restaurantId),
          eq(vouchers.code, code),
        ),
      )
      .limit(1)

    // Same message for unknown, inactive and expired — a differentiated error
    // turns this into an oracle for guessing valid codes.
    const invalid = new NotFoundError('That code is not valid.')

    if (!voucher || !voucher.isActive) throw invalid
    if (voucher.expiresAt && voucher.expiresAt <= new Date()) throw invalid

    const [alreadyOnBill] = await tx
      .select({ id: promotionRedemptions.id })
      .from(promotionRedemptions)
      .where(
        and(
          eq(promotionRedemptions.sessionId, sessionId),
          eq(promotionRedemptions.voucherId, voucher.id),
        ),
      )
      .limit(1)

    if (alreadyOnBill) {
      throw new ConflictError('That code has already been used on this bill.')
    }

    // Conditional claim, for the same reason promotions use one.
    const claimed = await tx
      .update(vouchers)
      .set({ redemptionCount: sql`${vouchers.redemptionCount} + 1` })
      .where(
        and(
          eq(vouchers.id, voucher.id),
          sql`${vouchers.redemptionCount} < ${vouchers.maxRedemptions}`,
        ),
      )
      .returning({ id: vouchers.id })

    if (claimed.length === 0) {
      throw new ConflictError('That code has already been fully redeemed.')
    }

    const [promotion] = await tx
      .select()
      .from(promotions)
      .where(eq(promotions.id, voucher.promotionId))
      .limit(1)

    if (!promotion || !promotion.isActive) throw invalid

    const context = await buildBillContext(
      tx,
      sessionId,
      [promotion.id],
      null,
      new Date(),
    )

    const result = evaluatePromotions([toDefinition(promotion)], context)
    const applied = result.applied[0]

    if (!applied) {
      throw new ConflictError(
        result.rejected[0]?.reason ??
          'That code does not apply to this bill yet.',
      )
    }

    await tx.insert(promotionRedemptions).values({
      restaurantId: ctx.restaurantId,
      sessionId,
      promotionId: promotion.id,
      voucherId: voucher.id,
      customerId: voucher.customerId,
      nameSnapshot: promotion.name,
      discountMinor: applied.discountMinor,
    })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'voucher.redeemed',
      entityType: 'dining_session',
      entityId: sessionId,
      after: { code, promotion: promotion.name, discountMinor: applied.discountMinor },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return {
      promotionName: promotion.name,
      discountMinor: applied.discountMinor,
    }
  })
}

/** Total automatic and voucher discount recorded against a bill. */
export async function readSessionPromotionDiscount(
  tx: Transaction,
  sessionId: string,
): Promise<{ totalMinor: number; entries: AppliedPromotionRecord[] }> {
  const rows = await tx
    .select({
      promotionId: promotionRedemptions.promotionId,
      name: promotionRedemptions.nameSnapshot,
      discountMinor: promotionRedemptions.discountMinor,
    })
    .from(promotionRedemptions)
    .where(eq(promotionRedemptions.sessionId, sessionId))

  return {
    totalMinor: rows.reduce((sum, r) => sum + r.discountMinor, 0),
    entries: rows.map((r) => ({
      promotionId: r.promotionId ?? '',
      name: r.name,
      discountMinor: r.discountMinor,
    })),
  }
}
