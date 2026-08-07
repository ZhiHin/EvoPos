import { and, eq, gte, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  branches,
  memberships,
  menuItems,
  restaurants,
  salesRecords,
} from '@/lib/db/schema'
import { NotFoundError, PlanLimitError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import {
  checkQuota,
  featureRefusal,
  planChangeEffect,
  planFor,
  quotaState,
  type Feature,
  type Plan,
  type PlanChangeEffect,
  type PlanKey,
  type Quota,
  type QuotaState,
} from './plans'

/**
 * Metering and gating.
 *
 * Usage is counted on demand rather than kept in a counter column. Entity
 * counts are three indexed `count(*)`s and the monthly bill count reads an
 * index that already exists for reporting — none of it is expensive, and a
 * cached usage figure that drifts is a customer refused a branch they are
 * entitled to, or granted one they are not.
 *
 * Phase 10 does cache stock levels, and the difference is the access pattern:
 * stock is read on every order line, this is read when somebody opens the
 * billing page or creates a branch.
 */

/** The window a monthly allowance is measured over: the calendar month. */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

async function countUsageIn(
  tx: Transaction,
  restaurantId: string,
  now: Date,
): Promise<Record<Quota, number>> {
  const [branchCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(branches)
    .where(eq(branches.restaurantId, restaurantId))

  /**
   * Active memberships only. A removed staff member keeps their row so the
   * audit trail still resolves their name, and counting them would charge a
   * restaurant for people who left.
   */
  const [staffCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.restaurantId, restaurantId),
        eq(memberships.status, 'active'),
      ),
    )

  const [itemCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(menuItems)
    .where(eq(menuItems.restaurantId, restaurantId))

  const [billCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(salesRecords)
    .where(
      and(
        eq(salesRecords.restaurantId, restaurantId),
        gte(salesRecords.settledAt, monthStart(now)),
      ),
    )

  return {
    branches: branchCount?.n ?? 0,
    staff: staffCount?.n ?? 0,
    menuItems: itemCount?.n ?? 0,
    monthlyBills: billCount?.n ?? 0,
  }
}

export interface PlanStatus {
  plan: Plan
  usage: Record<Quota, number>
  quotas: QuotaState[]
  /** Quotas already past their ceiling. Nothing here implies data loss. */
  overQuota: QuotaState[]
  periodStart: Date
}

export async function readPlanStatus(
  restaurantId: string,
  userId: string,
  now: Date = new Date(),
): Promise<PlanStatus> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const [row] = await tx
      .select({ plan: restaurants.plan })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1)

    if (!row) throw new NotFoundError('Restaurant not found.')

    const plan = planFor(row.plan)
    const usage = await countUsageIn(tx, restaurantId, now)

    const quotas = (Object.keys(usage) as Quota[]).map((quota) =>
      quotaState(quota, usage[quota], plan),
    )

    return {
      plan,
      usage,
      quotas,
      overQuota: quotas.filter((state) => state.isOverQuota),
      periodStart: monthStart(now),
    }
  })
}

/**
 * Refuses one more when the allowance is used up.
 *
 * Called at the point of creation in the service layer, not in a route — the
 * same limit has to hold whether a branch is created from the UI, from an API
 * key, or from a future import script.
 *
 * Deliberately NOT called for `monthlyBills`. That allowance is metered and
 * reported and never enforced, because enforcing it would mean the software
 * refusing to settle a bill on a busy Saturday — stopping a restaurant taking
 * money over a billing threshold. Going past it is a conversation, not an
 * outage, and a limit that could close a till is not a limit worth having.
 */
export async function assertQuota(
  ctx: { restaurantId: string; userId: string },
  quota: Quota,
  now: Date = new Date(),
): Promise<void> {
  const status = await readPlanStatus(ctx.restaurantId, ctx.userId, now)
  const refusal = checkQuota(quota, status.usage[quota], status.plan)

  if (refusal) {
    throw new PlanLimitError(refusal.message, refusal.upgradeTo)
  }
}

/** Refuses a capability the plan does not include. */
export async function assertFeature(
  ctx: { restaurantId: string; userId: string },
  feature: Feature,
): Promise<void> {
  const plan = await readPlan(ctx.restaurantId, ctx.userId)
  const refusal = featureRefusal(plan, feature)

  if (refusal) {
    throw new PlanLimitError(refusal.message, refusal.upgradeTo)
  }
}

/** Non-throwing check, for deciding whether to render a page's contents. */
export async function planHasFeature(
  ctx: { restaurantId: string; userId: string },
  feature: Feature,
): Promise<boolean> {
  const plan = await readPlan(ctx.restaurantId, ctx.userId)
  return featureRefusal(plan, feature) === null
}

export async function readPlan(
  restaurantId: string,
  userId: string,
): Promise<Plan> {
  const [row] = await withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({ plan: restaurants.plan })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1),
  )

  if (!row) throw new NotFoundError('Restaurant not found.')
  return planFor(row.plan)
}

/** What a change would mean, computed before anyone agrees to it. */
export async function previewPlanChange(
  restaurantId: string,
  userId: string,
  to: PlanKey,
  now: Date = new Date(),
): Promise<PlanChangeEffect> {
  const status = await readPlanStatus(restaurantId, userId, now)
  return planChangeEffect(status.plan.key, to, status.usage)
}

/**
 * Changes the plan.
 *
 * A downgrade that leaves the account over quota is allowed. Refusing it would
 * mean the only way to reduce spend is to delete data first, which is a
 * hostage-taking rather than a billing policy — the effect is recorded in the
 * audit trail so the conversation afterwards has facts in it.
 *
 * Nothing is deleted, disabled or hidden. The only consequence is that the
 * next create is refused.
 */
export async function changePlan(
  ctx: BranchActorContext,
  to: PlanKey,
  now: Date = new Date(),
): Promise<PlanChangeEffect> {
  const effect = await previewPlanChange(ctx.restaurantId, ctx.userId, to, now)

  await withTenant(ctx, async (tx) => {
    await tx
      .update(restaurants)
      .set({ plan: to, updatedAt: now })
      .where(eq(restaurants.id, ctx.restaurantId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'billing.plan_changed',
      entityType: 'restaurant',
      entityId: ctx.restaurantId,
      before: { plan: effect.from },
      after: {
        plan: effect.to,
        /**
         * Recorded because it is the part somebody will dispute later: which
         * limits the account was already past, and what switched off, at the
         * moment the change was agreed.
         */
        overQuotaOnChange: effect.wouldExceed.map((state) => state.quota),
        featuresLost: effect.wouldLose,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })

  return effect
}
