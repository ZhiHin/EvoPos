import { z } from 'zod'

/**
 * People think in percent; the database stores basis points. Converting at
 * the edge keeps every internal calculation on integers.
 */
export function percentToBasisPoints(percent: number): number {
  return Math.round(percent * 100)
}

export function basisPointsToPercent(basisPoints: number): number {
  return basisPoints / 100
}

/**
 * Accepts a percentage from the form and converts it.
 *
 * Capped at 100%: a rate above that is always a typo — usually entering 600
 * while thinking in basis points — and silently accepting it would put a bill
 * ten times too large in front of a customer.
 */
const percentageSchema = z
  .number()
  .min(0, 'Cannot be negative')
  .max(100, 'Cannot exceed 100%')
  .transform(percentToBasisPoints)

export const updateSettingsSchema = z.object({
  name: z.string().trim().min(1, 'Restaurant name is required').max(120),
  /** ISO 4217, three uppercase letters. Normalised before validation. */
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code')),
  /** IANA zone; checked against the runtime's own database in the service. */
  timezone: z.string().trim().min(1).max(64),
  locale: z.string().trim().min(2).max(10),
  taxRatePercent: percentageSchema,
  serviceChargePercent: percentageSchema,
  taxInclusive: z.boolean(),
  /**
   * Where the trading day starts, in minutes past local midnight.
   *
   * Stopped below 12 hours rather than below 24. A day starting at 14:00 no
   * longer names the day it belongs to, and the ambiguity would be silent —
   * every report would be off by one and nothing would say so.
   */
  businessDayStartMinutes: z
    .number()
    .int('Enter a whole number of minutes')
    .min(0, 'Cannot be negative')
    .max(719, 'The trading day must start before midday')
    .default(0),
})

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>
