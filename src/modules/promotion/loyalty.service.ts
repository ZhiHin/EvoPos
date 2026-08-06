import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  customers,
  loyaltyTiers,
  loyaltyTransactions,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'

/**
 * Loyalty points and tiers.
 *
 * The ledger is the only source of truth for a balance. There is no cached
 * total, because a cached total is a second answer to the same question and
 * the two drift the first time a write path forgets to update it.
 */

/**
 * Points earned per major currency unit spent.
 *
 * A constant for now rather than a per-restaurant setting: making it
 * configurable before anyone has asked for a different rate would be a
 * settings screen nobody opens, and it is a single column when they do.
 */
export const POINTS_PER_MAJOR_UNIT = 1

export function pointsForSpend(netSpendMinor: number): number {
  // Floored: a RM 9.90 bill earns 9 points, not 9.9 rounded up to 10.
  return Math.floor((netSpendMinor / 100) * POINTS_PER_MAJOR_UNIT)
}

export interface CustomerSummary {
  id: string
  name: string
  phone: string | null
  email: string | null
  tierId: string | null
  tierName: string | null
  pointsBalance: number
  lifetimePoints: number
}

export async function readBalanceIn(
  tx: Transaction,
  customerId: string,
): Promise<{ balance: number; lifetime: number }> {
  const [row] = await tx
    .select({
      balance: sql<number>`coalesce(sum(${loyaltyTransactions.points}), 0)::int`,
      lifetime: sql<number>`coalesce(sum(case when ${loyaltyTransactions.points} > 0 then ${loyaltyTransactions.points} else 0 end), 0)::int`,
    })
    .from(loyaltyTransactions)
    .where(eq(loyaltyTransactions.customerId, customerId))

  return { balance: row?.balance ?? 0, lifetime: row?.lifetime ?? 0 }
}

export async function readCustomer(
  restaurantId: string,
  userId: string,
  customerId: string,
): Promise<CustomerSummary> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const [customer] = await tx
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
        tierId: customers.tierId,
        tierName: loyaltyTiers.name,
      })
      .from(customers)
      .leftJoin(loyaltyTiers, eq(loyaltyTiers.id, customers.tierId))
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.restaurantId, restaurantId),
        ),
      )
      .limit(1)

    if (!customer) throw new NotFoundError('Customer not found.')

    const { balance, lifetime } = await readBalanceIn(tx, customerId)

    return { ...customer, pointsBalance: balance, lifetimePoints: lifetime }
  })
}

/**
 * Finds a customer by phone, or creates one.
 *
 * Phone is the practical identifier at a till — nobody spells an email across
 * a counter. Lookup-or-create in one call because a cashier asking "are you a
 * member?" should not have to know the answer before choosing which button to
 * press.
 */
export async function findOrCreateCustomer(
  ctx: BranchActorContext,
  input: { name: string; phone: string; email?: string },
): Promise<{ id: string; wasCreated: boolean }> {
  const phone = input.phone.trim()

  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.restaurantId, ctx.restaurantId),
          eq(customers.phone, phone),
        ),
      )
      .limit(1)

    if (existing) return { id: existing.id, wasCreated: false }

    const [created] = await tx
      .insert(customers)
      .values({
        restaurantId: ctx.restaurantId,
        name: input.name.trim(),
        phone,
        email: input.email?.trim() || null,
      })
      .returning({ id: customers.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'customer.created',
      entityType: 'customer',
      entityId: created.id,
      after: { name: input.name, phone },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id, wasCreated: true }
  })
}

/**
 * Recomputes and stores a customer's tier from their lifetime points.
 *
 * Lifetime rather than current balance, so spending points does not demote
 * someone — a tier is recognition of what they have spent, and taking it away
 * because they used a reward is the fastest way to make the reward feel like
 * a punishment.
 */
export async function refreshTier(
  tx: Transaction,
  restaurantId: string,
  customerId: string,
): Promise<string | null> {
  const { lifetime } = await readBalanceIn(tx, customerId)

  const [tier] = await tx
    .select({ id: loyaltyTiers.id })
    .from(loyaltyTiers)
    .where(
      and(
        eq(loyaltyTiers.restaurantId, restaurantId),
        lte(loyaltyTiers.minPoints, lifetime),
      ),
    )
    .orderBy(desc(loyaltyTiers.minPoints))
    .limit(1)

  const tierId = tier?.id ?? null

  await tx
    .update(customers)
    .set({ tierId })
    .where(eq(customers.id, customerId))

  return tierId
}

async function record(
  tx: Transaction,
  restaurantId: string,
  input: {
    customerId: string
    kind: 'earn' | 'redeem' | 'adjust' | 'expire'
    points: number
    reason: string
    sessionId?: string | null
    idempotencyKey?: string | null
    userId?: string | null
  },
): Promise<{ id: string; wasReplay: boolean }> {
  if (input.idempotencyKey) {
    const [existing] = await tx
      .select({ id: loyaltyTransactions.id })
      .from(loyaltyTransactions)
      .where(
        and(
          eq(loyaltyTransactions.restaurantId, restaurantId),
          eq(loyaltyTransactions.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)

    if (existing) return { id: existing.id, wasReplay: true }
  }

  const [created] = await tx
    .insert(loyaltyTransactions)
    .values({
      restaurantId,
      customerId: input.customerId,
      kind: input.kind,
      points: input.points,
      reason: input.reason,
      sessionId: input.sessionId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.userId ?? null,
    })
    .returning({ id: loyaltyTransactions.id })

  await refreshTier(tx, restaurantId, input.customerId)

  return { id: created.id, wasReplay: false }
}

/**
 * Awards points for a settled bill.
 *
 * Idempotent on the session, so a retried settlement does not pay out twice —
 * the same failure mode payments guard against, with the same fix.
 */
export async function earnPointsForSession(
  ctx: BranchActorContext,
  customerId: string,
  sessionId: string,
  netSpendMinor: number,
): Promise<{ pointsEarned: number; wasReplay: boolean }> {
  const points = pointsForSpend(netSpendMinor)

  if (points <= 0) return { pointsEarned: 0, wasReplay: false }

  return withTenant(ctx, async (tx) => {
    const result = await record(tx, ctx.restaurantId, {
      customerId,
      kind: 'earn',
      points,
      reason: `Earned on bill ${sessionId.slice(0, 6).toUpperCase()}`,
      sessionId,
      idempotencyKey: `earn:${sessionId}`,
      userId: ctx.userId,
    })

    return { pointsEarned: result.wasReplay ? 0 : points, wasReplay: result.wasReplay }
  })
}

export async function redeemPoints(
  ctx: BranchActorContext,
  customerId: string,
  points: number,
  reason: string,
  sessionId?: string,
): Promise<void> {
  if (!Number.isInteger(points) || points <= 0) {
    throw new ValidationError('Enter a whole number of points to redeem.', {
      points: ['Enter a whole number of points to redeem.'],
    })
  }

  await withTenant(ctx, async (tx) => {
    const { balance } = await readBalanceIn(tx, customerId)

    /**
     * Checked inside the transaction against the ledger, so two tills
     * redeeming the same points concurrently cannot both pass. Serialisable
     * isolation would be stricter still; this is enough given a customer is
     * physically at one till.
     */
    if (points > balance) {
      throw new ConflictError(
        `That customer has ${balance} points, which is not enough for ${points}.`,
      )
    }

    await record(tx, ctx.restaurantId, {
      customerId,
      kind: 'redeem',
      points: -points,
      reason,
      sessionId: sessionId ?? null,
      userId: ctx.userId,
    })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'loyalty.redeemed',
      entityType: 'customer',
      entityId: customerId,
      after: { points, reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/** Manual correction. Signed, reasoned, and audited — it moves real value. */
export async function adjustPoints(
  ctx: BranchActorContext,
  customerId: string,
  points: number,
  reason: string,
): Promise<void> {
  if (!Number.isInteger(points) || points === 0) {
    throw new ValidationError('Enter a non-zero whole number of points.', {
      points: ['Enter a non-zero whole number of points.'],
    })
  }

  await withTenant(ctx, async (tx) => {
    if (points < 0) {
      const { balance } = await readBalanceIn(tx, customerId)
      if (balance + points < 0) {
        throw new ConflictError(
          `That would take the balance below zero — the customer has ${balance} points.`,
        )
      }
    }

    await record(tx, ctx.restaurantId, {
      customerId,
      kind: 'adjust',
      points,
      reason,
      userId: ctx.userId,
    })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'loyalty.adjusted',
      entityType: 'customer',
      entityId: customerId,
      after: { points, reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function listTiers(
  restaurantId: string,
  userId: string,
): Promise<(typeof loyaltyTiers.$inferSelect)[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select()
      .from(loyaltyTiers)
      .where(eq(loyaltyTiers.restaurantId, restaurantId))
      .orderBy(asc(loyaltyTiers.minPoints)),
  )
}

export async function createTier(
  ctx: BranchActorContext,
  input: { name: string; minPoints: number; displayOrder: number },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [clash] = await tx
      .select({ id: loyaltyTiers.id })
      .from(loyaltyTiers)
      .where(
        and(
          eq(loyaltyTiers.restaurantId, ctx.restaurantId),
          eq(loyaltyTiers.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(`A tier called "${input.name}" already exists.`)
    }

    const [created] = await tx
      .insert(loyaltyTiers)
      .values({
        restaurantId: ctx.restaurantId,
        name: input.name,
        minPoints: input.minPoints,
        displayOrder: input.displayOrder,
      })
      .returning({ id: loyaltyTiers.id })

    return { id: created.id }
  })
}
