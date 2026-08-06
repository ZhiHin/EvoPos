import { z } from 'zod'

/**
 * Split strategy input.
 *
 * A discriminated union so the shape of the extra fields is tied to the
 * strategy that needs them — percentages cannot arrive on an even split, and
 * assignments cannot arrive without `by_item`.
 */
export const splitStrategySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('by_owner') }),
  z.object({ kind: z.literal('even') }),
  z.object({
    kind: z.literal('by_percentage'),
    /**
     * Percentages arrive as human percent and convert to basis points here,
     * at the edge, so the engine only ever sees integers.
     */
    percentages: z
      .record(z.uuid(), z.union([z.number(), z.string()]))
      .transform((raw, ctx) => {
        const weights: Record<string, number> = {}

        for (const [memberId, value] of Object.entries(raw)) {
          const percent = Number(value)
          if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
            ctx.addIssue({
              code: 'custom',
              message: 'Each share must be between 0 and 100 percent',
            })
            return z.NEVER
          }
          weights[memberId] = Math.round(percent * 100)
        }

        return weights
      }),
  }),
  z.object({
    kind: z.literal('by_item'),
    assignments: z
      .array(
        z.object({
          lineId: z.uuid(),
          memberId: z.uuid(),
          quantity: z.number().int().min(1).max(999).optional(),
        }),
      )
      .max(500),
  }),
])

export const previewSplitSchema = z.object({
  strategy: splitStrategySchema,
})

export const lockSplitSchema = z.object({
  strategy: splitStrategySchema,
  /**
   * The bill total the cashier was looking at when they pressed lock.
   *
   * If an order landed in between, the server rejects rather than silently
   * locking a different number than the one on screen — the classic
   * lost-update problem, and one that ends with a customer being charged for
   * something they never saw.
   */
  expectedBillTotalMinor: z.number().int().min(0),
})

export const voidSplitSchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason').max(200),
})

export type SplitStrategyInput = z.infer<typeof splitStrategySchema>
export type PreviewSplitInput = z.infer<typeof previewSplitSchema>
export type LockSplitInput = z.infer<typeof lockSplitSchema>
export type VoidSplitInput = z.infer<typeof voidSplitSchema>
