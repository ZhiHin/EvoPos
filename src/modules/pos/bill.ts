/**
 * Bill calculation.
 *
 * Pure, like the Phase 3 pricing engine, and for the same reason: this is the
 * arithmetic that decides what a customer pays. It is called from the POS,
 * from the diner's screen, and — from Phase 6 — from the Smart Bill splitter,
 * so it must be exhaustively testable without a database or a tenant.
 *
 * Everything is integer minor units. Rates are integer basis points.
 */

export interface BillSettings {
  /** e.g. 600 = 6.00% */
  taxRateBasisPoints: number
  serviceChargeBasisPoints: number
  /** True when menu prices already contain tax. */
  taxInclusive: boolean
}

export interface BillDiscount {
  type: 'percentage' | 'fixed'
  /** Basis points when percentage, minor units when fixed. */
  value: number
  reason: string
}

export interface BillTotals {
  subtotalMinor: number
  discountMinor: number
  discountedSubtotalMinor: number
  serviceChargeMinor: number
  taxMinor: number
  totalMinor: number
  /**
   * True when `taxMinor` was extracted from the total rather than added to
   * it. A receipt must say "inclusive of 6% SST" rather than listing it as a
   * separate charge, and the difference is not cosmetic.
   */
  taxIsIncluded: boolean
}

/**
 * Applies a basis-point rate to an amount.
 *
 * `Math.round`, not truncation, and applied once at the end of the
 * multiplication. Truncating consistently rounds the restaurant's takings
 * down by up to a cent per line, which across a service is a real and
 * unexplainable shortfall in the till.
 */
export function applyRate(amountMinor: number, basisPoints: number): number {
  return Math.round((amountMinor * basisPoints) / 10_000)
}

/**
 * Extracts the tax already contained in a gross amount.
 *
 * gross = net × (1 + rate), so net = gross / (1 + rate) and tax is the
 * remainder. Computed as a subtraction rather than a second rounding so that
 * net + tax always equals gross exactly — otherwise a receipt's own lines
 * fail to add up to its total, which customers notice and accountants refuse
 * to accept.
 */
export function extractIncludedTax(
  grossMinor: number,
  taxRateBasisPoints: number,
): number {
  if (taxRateBasisPoints <= 0) return 0

  const net = Math.round(
    (grossMinor * 10_000) / (10_000 + taxRateBasisPoints),
  )
  return grossMinor - net
}

/**
 * Total value of a set of discounts against a subtotal.
 *
 * Every discount is computed against the ORIGINAL subtotal and the results
 * summed — not applied one after another to a shrinking balance. Sequential
 * application makes the order matter, so "10% off then RM5 off" and "RM5 off
 * then 10% off" give different answers, and no one can explain which the till
 * chose. Computing against a fixed base makes a bill reproducible.
 *
 * Capped at the subtotal: a bill may reach zero but never go negative, which
 * would turn an over-generous discount into the restaurant owing money.
 */
export function calculateDiscount(
  subtotalMinor: number,
  discounts: readonly BillDiscount[],
): number {
  const raw = discounts.reduce((total, discount) => {
    if (discount.type === 'percentage') {
      // Rates above 100% are meaningless; clamp rather than reject, since
      // this function must not throw on data already in the database.
      return total + applyRate(subtotalMinor, Math.min(discount.value, 10_000))
    }
    return total + Math.max(0, discount.value)
  }, 0)

  return Math.min(raw, subtotalMinor)
}

/**
 * Computes a bill.
 *
 * Order of operations, which is a business decision rather than an
 * implementation detail:
 *
 *   1. Subtotal — sum of line totals.
 *   2. Discount — against the subtotal.
 *   3. Service charge — on the DISCOUNTED subtotal, so a discount reduces the
 *      service charge too. Charging service on an amount the customer is not
 *      paying is difficult to defend.
 *   4. Tax — on the discounted subtotal PLUS the service charge, because a
 *      service charge is itself taxable in most jurisdictions this targets.
 *
 * In tax-inclusive mode the line totals already contain tax, so nothing is
 * added: the service charge is applied to the inclusive amount and the tax is
 * extracted from the final total for display.
 *
 * Jurisdictions differ on whether service charge is taxable and on whether it
 * is itself inclusive. This model matches Malaysian practice (SST plus a
 * 10% service charge); a deployment elsewhere should revisit steps 3 and 4
 * deliberately rather than assume they transfer.
 */
export function calculateBill(
  lineTotalsMinor: readonly number[],
  settings: BillSettings,
  discounts: readonly BillDiscount[] = [],
): BillTotals {
  const subtotalMinor = lineTotalsMinor.reduce((sum, l) => sum + l, 0)
  const discountMinor = calculateDiscount(subtotalMinor, discounts)
  const discountedSubtotalMinor = subtotalMinor - discountMinor

  const serviceChargeMinor = applyRate(
    discountedSubtotalMinor,
    settings.serviceChargeBasisPoints,
  )

  if (settings.taxInclusive) {
    const totalMinor = discountedSubtotalMinor + serviceChargeMinor

    return {
      subtotalMinor,
      discountMinor,
      discountedSubtotalMinor,
      serviceChargeMinor,
      taxMinor: extractIncludedTax(totalMinor, settings.taxRateBasisPoints),
      totalMinor,
      taxIsIncluded: true,
    }
  }

  const taxMinor = applyRate(
    discountedSubtotalMinor + serviceChargeMinor,
    settings.taxRateBasisPoints,
  )

  return {
    subtotalMinor,
    discountMinor,
    discountedSubtotalMinor,
    serviceChargeMinor,
    taxMinor,
    totalMinor: discountedSubtotalMinor + serviceChargeMinor + taxMinor,
    taxIsIncluded: false,
  }
}

/**
 * Rounds a total to the nearest cash increment.
 *
 * Malaysia withdrew the 1 and 5 sen coins, so cash payments round to the
 * nearest 5 sen while card and e-wallet payments are charged exactly. The
 * rounding adjustment is returned separately because it must appear on the
 * receipt as its own line — a total that silently differs from the sum of its
 * parts is the fastest way to lose a customer's trust at the counter.
 */
export function roundForCash(
  totalMinor: number,
  incrementMinor = 5,
): { roundedMinor: number; adjustmentMinor: number } {
  if (incrementMinor <= 1) {
    return { roundedMinor: totalMinor, adjustmentMinor: 0 }
  }

  const roundedMinor =
    Math.round(totalMinor / incrementMinor) * incrementMinor

  return { roundedMinor, adjustmentMinor: roundedMinor - totalMinor }
}
