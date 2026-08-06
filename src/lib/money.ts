/**
 * Money formatting.
 *
 * Everything in the system stores integer minor units. These helpers are the
 * only place that converts to and from the decimal form a human reads, so
 * there is exactly one rounding rule in the codebase.
 */

/** 1250 -> "12.50". No currency symbol; use `formatMoney` for display. */
export function minorToDecimalString(minor: number): string {
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * 1250, "MYR" -> "RM 12.50"
 *
 * Falls back to the raw code if the runtime does not know the currency,
 * rather than throwing — a bad currency setting should make a price look odd,
 * not take down the page it appears on.
 */
export function formatMoney(
  minor: number,
  currency: string,
  locale = 'en-MY',
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).format(minor / 100)
  } catch {
    return `${currency} ${minorToDecimalString(minor)}`
  }
}

/** Basis points to a display percentage: 600 -> "6%", 825 -> "8.25%". */
export function formatBasisPoints(basisPoints: number): string {
  return `${String(basisPoints / 100)}%`
}
