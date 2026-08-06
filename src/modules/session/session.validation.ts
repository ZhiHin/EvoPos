import { z } from 'zod'

export const joinSessionSchema = z.object({
  /**
   * Shown to everyone at the table and printed on the bill, so it is treated
   * as display text rather than an identifier: trimmed, length-capped, and
   * never used for lookup.
   */
  displayName: z
    .string()
    .trim()
    .min(1, 'Enter a name so the table knows whose order is whose')
    .max(40, 'That name is a little long'),
})

export const placeOrderSchema = z.object({
  lines: z
    .array(
      z.object({
        menuItemId: z.uuid(),
        quantity: z.number().int().min(1).max(99),
        notes: z.string().trim().max(300).optional(),
        /** True when the dish is for the table rather than one person. */
        isShared: z.boolean().default(false),
        modifierSelections: z
          .array(
            z.object({
              groupId: z.uuid(),
              optionId: z.uuid(),
              quantity: z.number().int().min(1).max(20).default(1),
            }),
          )
          .max(50)
          .default([]),
      }),
    )
    .min(1, 'Add something to your order first')
    .max(50, 'That is too many items in one order'),
})

export const serviceRequestSchema = z.object({
  type: z.enum(['call_waiter', 'request_bill']),
  note: z.string().trim().max(300).optional(),
})

export type JoinSessionInput = z.infer<typeof joinSessionSchema>
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>
export type ServiceRequestInput = z.infer<typeof serviceRequestSchema>
