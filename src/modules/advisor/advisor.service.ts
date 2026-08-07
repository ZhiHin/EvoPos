import { and, eq, gt, isNull, or } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import { insightDismissals, restaurants, users } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import type { ReportRange } from '@/modules/reporting/report'
import type { ReportContext } from '@/modules/reporting/report.service'
import { gatherEvidence } from './evidence.service'
import { generateInsights, type Insight } from './insights'
import { createNarrator, type Briefing } from './narrator'

/**
 * The advisor.
 *
 * Reads the evidence, runs the pure engine over it, hides what has been
 * answered, and asks a narrator to introduce what is left. It holds no state
 * of its own — every recommendation is recomputed on every read, so a finding
 * can never outlive the fact behind it.
 */

export interface DismissedInsight {
  insightKey: string
  reason: string
  dismissedBy: string | null
  snoozedUntil: Date | null
}

export interface AdvisorReport {
  range: ReportRange
  briefing: Briefing
  insights: Insight[]
  /** Set when the engine declined to advise, with its reason. */
  refusal: string | null
  /** Findings currently answered, so the reader knows what is being hidden. */
  dismissed: DismissedInsight[]
}

/**
 * Dismissals still in force.
 *
 * A snooze that has expired is simply not returned — the row stays, because
 * "we snoozed this in March and it came back" is a question worth being able
 * to answer, and deleting the row destroys the only record that it did.
 */
async function readActiveDismissalsIn(
  ctx: ReportContext,
  now: Date,
): Promise<Map<string, DismissedInsight>> {
  const rows = await withTenant(ctx, (tx) =>
    tx
      .select({
        insightKey: insightDismissals.insightKey,
        reason: insightDismissals.reason,
        dismissedBy: users.name,
        snoozedUntil: insightDismissals.snoozedUntil,
      })
      .from(insightDismissals)
      .leftJoin(users, eq(users.id, insightDismissals.dismissedByUserId))
      .where(
        and(
          eq(insightDismissals.restaurantId, ctx.restaurantId),
          or(
            isNull(insightDismissals.snoozedUntil),
            gt(insightDismissals.snoozedUntil, now),
          ),
        ),
      ),
  )

  return new Map(rows.map((row) => [row.insightKey, row]))
}

export async function readAdvisorReport(
  ctx: ReportContext,
  range: ReportRange,
  branchId: string | null = null,
  now: Date = new Date(),
): Promise<AdvisorReport> {
  const [snapshot, dismissals, restaurant] = await Promise.all([
    gatherEvidence(ctx, range, branchId, now),
    readActiveDismissalsIn(ctx, now),
    withTenant(ctx, (tx) =>
      tx
        .select({ name: restaurants.name })
        .from(restaurants)
        .where(eq(restaurants.id, ctx.restaurantId))
        .limit(1),
    ),
  ])

  const result = generateInsights(snapshot)

  /**
   * Dismissed findings are removed before the narrator sees them, so the
   * briefing describes what is actually on screen. A summary that opens with a
   * finding the reader has already answered and hidden reads as if nobody is
   * listening.
   */
  const visible = result.insights.filter(
    (insight) => !dismissals.has(insight.key),
  )

  const periodDays = snapshot.periodDays
  const restaurantName = restaurant[0]?.name ?? 'this restaurant'

  const briefing = await createNarrator(env.ANTHROPIC_API_KEY).write(
    visible,
    result.refusal,
    { periodDays, restaurantName },
  )

  return {
    range,
    briefing,
    insights: visible,
    refusal: result.refusal,
    /** Only the ones this period actually raised — not every dismissal ever. */
    dismissed: result.insights
      .filter((insight) => dismissals.has(insight.key))
      .map((insight) => dismissals.get(insight.key))
      .filter((row): row is DismissedInsight => row !== undefined),
  }
}

/**
 * Answers a recommendation.
 *
 * Upserts rather than stacking rows: the current answer is the only answer, so
 * "why is this hidden?" has exactly one response. Audited, because dismissing
 * is how an inconvenient finding is made to disappear — and the audit trail is
 * the only thing that distinguishes "we know, and here is why" from quietly
 * turning off the alarm.
 */
export async function dismissInsight(
  actor: BranchActorContext,
  input: { insightKey: string; reason: string; snoozeDays?: number | null },
  now: Date = new Date(),
): Promise<void> {
  if (input.reason.trim().length === 0) {
    throw new ValidationError('Say why you are dismissing this.', {
      reason: ['A reason is required.'],
    })
  }

  const snoozedUntil =
    input.snoozeDays && input.snoozeDays > 0
      ? new Date(now.getTime() + input.snoozeDays * 24 * 60 * 60_000)
      : null

  await withTenant(actor, async (tx) => {
    await tx
      .insert(insightDismissals)
      .values({
        restaurantId: actor.restaurantId,
        insightKey: input.insightKey,
        reason: input.reason.trim(),
        snoozedUntil,
        dismissedByUserId: actor.userId,
      })
      .onConflictDoUpdate({
        target: [
          insightDismissals.restaurantId,
          insightDismissals.insightKey,
        ],
        set: {
          reason: input.reason.trim(),
          snoozedUntil,
          dismissedByUserId: actor.userId,
          updatedAt: now,
        },
      })

    await recordAuditIn(tx, {
      restaurantId: actor.restaurantId,
      actorUserId: actor.userId,
      action: 'insight.dismissed',
      entityType: 'insight',
      entityId: input.insightKey,
      after: {
        reason: input.reason.trim(),
        snoozedUntil: snoozedUntil?.toISOString() ?? null,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    })
  })
}

/** Un-hides a recommendation. */
export async function restoreInsight(
  actor: BranchActorContext,
  insightKey: string,
): Promise<void> {
  await withTenant(actor, async (tx) => {
    const deleted = await tx
      .delete(insightDismissals)
      .where(
        and(
          eq(insightDismissals.restaurantId, actor.restaurantId),
          eq(insightDismissals.insightKey, insightKey),
        ),
      )
      .returning({ id: insightDismissals.id })

    if (deleted.length === 0) return

    await recordAuditIn(tx, {
      restaurantId: actor.restaurantId,
      actorUserId: actor.userId,
      action: 'insight.restored',
      entityType: 'insight',
      entityId: insightKey,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    })
  })
}

/** How many findings are outstanding, for a badge. */
export async function countOpenInsights(
  ctx: ReportContext,
  range: ReportRange,
  now: Date = new Date(),
): Promise<number> {
  const [snapshot, dismissals] = await Promise.all([
    gatherEvidence(ctx, range, null, now),
    readActiveDismissalsIn(ctx, now),
  ])

  return generateInsights(snapshot).insights.filter(
    (insight) =>
      !dismissals.has(insight.key) && insight.severity !== 'info',
  ).length
}
