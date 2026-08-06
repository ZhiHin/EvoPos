import { applyRate } from '@/modules/pos/bill'

/**
 * The promotion rule engine.
 *
 * Pure, and deliberately produces *proposed discounts* rather than touching a
 * bill. Those proposals feed the Phase 5 bill engine exactly like a manual
 * discount does, so an automatic 10% and a manager's 10% are computed by the
 * same arithmetic and can never disagree.
 *
 * Everything is integer minor units; rates are integer basis points.
 */

export type PromotionKind =
  /** A percentage off the promotion's scope. */
  | 'percentage'
  /** A flat amount off. */
  | 'fixed'
  /** Cheapest item free for every pair of qualifying items. */
  | 'bogo'
  /** The single cheapest qualifying item free. */
  | 'free_item'

export interface PromotionConditions {
  validFrom: Date | null
  validTo: Date | null
  /** 0 = Sunday. Empty means every day. */
  daysOfWeek: number[]
  /** "HH:MM". Both null means all day. */
  startTime: string | null
  endTime: string | null
  /** Empty means every branch. */
  branchIds: string[]
  minSpendMinor: number
  /** Empty means every category / item — i.e. the whole bill. */
  categoryIds: string[]
  menuItemIds: string[]
  /** Minimum qualifying items on the bill. */
  minQuantity: number
  requiredTierId: string | null
  /** True when a voucher code must be presented to unlock it. */
  requiresVoucher: boolean
}

export interface PromotionDefinition {
  id: string
  name: string
  kind: PromotionKind
  /** Basis points for `percentage`, minor units for `fixed`, unused otherwise. */
  value: number
  /** Lower runs first. */
  priority: number
  /**
   * Stackable promotions combine with each other. A non-stackable one applies
   * alone.
   *
   * Modelled as one flag rather than separate "stackable" and "exclusive"
   * flags, because the two collapse: a promotion that cannot stack and is not
   * exclusive would mean nothing distinguishable.
   */
  isStackable: boolean
  conditions: PromotionConditions
  /** Null means unlimited. */
  usageRemaining: number | null
}

export interface BillLineContext {
  lineId: string
  menuItemId: string | null
  categoryId: string | null
  quantity: number
  unitPriceMinor: number
  lineTotalMinor: number
}

export interface BillContext {
  now: Date
  branchId: string
  subtotalMinor: number
  lines: BillLineContext[]
  customerTierId: string | null
  /** Promotions unlocked by a voucher code already presented. */
  unlockedPromotionIds: string[]
}

export interface AppliedPromotion {
  promotionId: string
  name: string
  kind: PromotionKind
  discountMinor: number
}

export interface RejectedPromotion {
  promotionId: string
  name: string
  reason: string
}

export interface EvaluationResult {
  applied: AppliedPromotion[]
  totalDiscountMinor: number
  /** Why each ineligible promotion did not apply — for the admin screen. */
  rejected: RejectedPromotion[]
}

/** "HH:MM" to minutes past midnight. */
function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

/**
 * Whether the clock falls inside a window.
 *
 * Handles windows that cross midnight — a 22:00–02:00 late-night promotion is
 * an ordinary thing to configure, and treating start > end as invalid would
 * quietly disable it rather than reject it at definition time.
 */
export function isWithinTimeWindow(
  now: Date,
  startTime: string | null,
  endTime: string | null,
): boolean {
  if (!startTime || !endTime) return true

  const current = now.getHours() * 60 + now.getMinutes()
  const start = toMinutes(startTime)
  const end = toMinutes(endTime)

  return start <= end
    ? current >= start && current < end
    : current >= start || current < end
}

/** Lines the promotion applies to. Empty product filters mean the whole bill. */
export function scopedLines(
  promotion: PromotionDefinition,
  lines: readonly BillLineContext[],
): BillLineContext[] {
  const { categoryIds, menuItemIds } = promotion.conditions

  if (categoryIds.length === 0 && menuItemIds.length === 0) return [...lines]

  return lines.filter(
    (line) =>
      (line.menuItemId !== null && menuItemIds.includes(line.menuItemId)) ||
      (line.categoryId !== null && categoryIds.includes(line.categoryId)),
  )
}

/**
 * Whether a promotion may apply, and why not if it may not.
 *
 * Returns the reason rather than a bare boolean so the admin screen can
 * explain "this promotion is not running because the minimum spend is not
 * met" instead of leaving someone to guess why their configuration does
 * nothing.
 */
export function checkEligibility(
  promotion: PromotionDefinition,
  context: BillContext,
): { eligible: true } | { eligible: false; reason: string } {
  const c = promotion.conditions

  if (promotion.usageRemaining !== null && promotion.usageRemaining <= 0) {
    return { eligible: false, reason: 'Usage limit reached' }
  }

  if (c.validFrom && context.now < c.validFrom) {
    return { eligible: false, reason: 'Not started yet' }
  }

  if (c.validTo && context.now >= c.validTo) {
    return { eligible: false, reason: 'Expired' }
  }

  if (c.daysOfWeek.length > 0 && !c.daysOfWeek.includes(context.now.getDay())) {
    return { eligible: false, reason: 'Not available today' }
  }

  if (!isWithinTimeWindow(context.now, c.startTime, c.endTime)) {
    return { eligible: false, reason: 'Outside its time window' }
  }

  if (c.branchIds.length > 0 && !c.branchIds.includes(context.branchId)) {
    return { eligible: false, reason: 'Not available at this branch' }
  }

  if (context.subtotalMinor < c.minSpendMinor) {
    return {
      eligible: false,
      reason: `Minimum spend of ${(c.minSpendMinor / 100).toFixed(2)} not reached`,
    }
  }

  if (c.requiredTierId && context.customerTierId !== c.requiredTierId) {
    return { eligible: false, reason: 'Requires a different membership tier' }
  }

  if (c.requiresVoucher && !context.unlockedPromotionIds.includes(promotion.id)) {
    return { eligible: false, reason: 'Needs a voucher code' }
  }

  const scoped = scopedLines(promotion, context.lines)

  if (scoped.length === 0) {
    return { eligible: false, reason: 'Nothing on the bill qualifies' }
  }

  const qualifyingQuantity = scoped.reduce((sum, l) => sum + l.quantity, 0)

  if (qualifyingQuantity < c.minQuantity) {
    return {
      eligible: false,
      reason: `Needs at least ${c.minQuantity} qualifying item(s)`,
    }
  }

  return { eligible: true }
}

/**
 * What a promotion is worth against this bill.
 *
 * Never exceeds the value of the lines it applies to — a fixed RM 20 off
 * against a RM 12 dish discounts 12, not 20, or the promotion would start
 * eating into items it was never meant to touch.
 */
export function calculatePromotionDiscount(
  promotion: PromotionDefinition,
  context: BillContext,
): number {
  const scoped = scopedLines(promotion, context.lines)
  const scopeMinor = scoped.reduce((sum, l) => sum + l.lineTotalMinor, 0)

  switch (promotion.kind) {
    case 'percentage':
      return Math.min(
        applyRate(scopeMinor, Math.min(promotion.value, 10_000)),
        scopeMinor,
      )

    case 'fixed':
      return Math.min(Math.max(0, promotion.value), scopeMinor)

    /**
     * The cheapest of every pair is free. Sorting by unit price and freeing
     * the cheapest halves is the customer-unfavourable-but-standard reading
     * of "buy one get one free"; freeing the dearest would let someone pair a
     * coffee with a steak and take the steak.
     */
    case 'bogo': {
      const units: number[] = []
      for (const line of scoped) {
        for (let i = 0; i < line.quantity; i++) units.push(line.unitPriceMinor)
      }
      units.sort((a, b) => a - b)

      const freeCount = Math.floor(units.length / 2)
      return units.slice(0, freeCount).reduce((sum, price) => sum + price, 0)
    }

    case 'free_item': {
      const cheapest = scoped.reduce(
        (min, line) => Math.min(min, line.unitPriceMinor),
        Number.POSITIVE_INFINITY,
      )
      return Number.isFinite(cheapest) ? cheapest : 0
    }
  }
}

/**
 * Decides which promotions apply to a bill.
 *
 * Ordering is: priority ascending, then largest discount first, then id. The
 * middle tiebreak matters — when two promotions of equal priority both
 * qualify, the customer gets the better one, and the id keeps the result
 * deterministic so a figure shown on screen matches the one recorded a moment
 * later.
 *
 * The first eligible promotion always applies. If it does not stack, it
 * applies alone. If it does, every subsequent stackable promotion joins it.
 *
 * The total is capped at the subtotal: a stack of generous promotions makes a
 * bill free, never negative.
 */
export function evaluatePromotions(
  promotions: readonly PromotionDefinition[],
  context: BillContext,
): EvaluationResult {
  const rejected: RejectedPromotion[] = []
  const candidates: { promotion: PromotionDefinition; discountMinor: number }[] =
    []

  for (const promotion of promotions) {
    const eligibility = checkEligibility(promotion, context)

    if (!eligibility.eligible) {
      rejected.push({
        promotionId: promotion.id,
        name: promotion.name,
        reason: eligibility.reason,
      })
      continue
    }

    const discountMinor = calculatePromotionDiscount(promotion, context)

    /**
     * A promotion that qualifies but is worth nothing — 0% off, or a free
     * item on a bill of free items — is neither applied nor silently
     * dropped. Showing it as applied with no effect is more confusing than
     * saying it was worth nothing.
     */
    if (discountMinor <= 0) {
      rejected.push({
        promotionId: promotion.id,
        name: promotion.name,
        reason: 'Worth nothing on this bill',
      })
      continue
    }

    candidates.push({ promotion, discountMinor })
  }

  candidates.sort((a, b) => {
    if (a.promotion.priority !== b.promotion.priority) {
      return a.promotion.priority - b.promotion.priority
    }
    if (a.discountMinor !== b.discountMinor) {
      return b.discountMinor - a.discountMinor
    }
    return a.promotion.id.localeCompare(b.promotion.id)
  })

  const applied: AppliedPromotion[] = []

  for (const [index, candidate] of candidates.entries()) {
    const isFirst = applied.length === 0

    if (!isFirst && !candidate.promotion.isStackable) {
      rejected.push({
        promotionId: candidate.promotion.id,
        name: candidate.promotion.name,
        reason: 'Cannot be combined with another promotion',
      })
      continue
    }

    applied.push({
      promotionId: candidate.promotion.id,
      name: candidate.promotion.name,
      kind: candidate.promotion.kind,
      discountMinor: candidate.discountMinor,
    })

    if (!candidate.promotion.isStackable) {
      /**
       * A non-stackable promotion applied first takes the bill on its own —
       * but everything it displaced still needs a reason. Breaking without
       * recording them would leave the admin screen silent about promotions
       * that qualified and lost, which is exactly the case someone is trying
       * to understand when they open it.
       */
      for (const displaced of candidates.slice(index + 1)) {
        rejected.push({
          promotionId: displaced.promotion.id,
          name: displaced.promotion.name,
          reason: `Superseded by "${candidate.promotion.name}", which cannot be combined`,
        })
      }
      break
    }
  }

  const rawTotal = applied.reduce((sum, a) => sum + a.discountMinor, 0)
  const totalDiscountMinor = Math.min(rawTotal, context.subtotalMinor)

  return { applied, totalDiscountMinor, rejected }
}
