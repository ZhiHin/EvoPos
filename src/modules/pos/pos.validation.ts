import { z } from 'zod'

import { priceMinorSchema } from '@/modules/menu/menu.validation'

export const openTakeawaySchema = z
  .object({
    type: z.enum(['takeaway', 'delivery']),
    branchId: z.uuid(),
    customerName: z.string().trim().max(120).optional(),
    customerPhone: z.string().trim().max(40).optional(),
    deliveryAddress: z.string().trim().max(400).optional(),
  })
  .refine((v) => v.type !== 'delivery' || !!v.deliveryAddress, {
    message: 'A delivery order needs an address',
    path: ['deliveryAddress'],
  })

export const staffOrderSchema = z.object({
  lines: z
    .array(
      z.object({
        menuItemId: z.uuid(),
        quantity: z.number().int().min(1).max(99),
        notes: z.string().trim().max(300).optional(),
        /** Attribute to a specific diner; omit for the table as a whole. */
        memberId: z.uuid().nullable().optional(),
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
    .min(1)
    .max(50),
})

export const transferSessionSchema = z.object({
  tableId: z.uuid(),
})

export const mergeSessionsSchema = z.object({
  /** The session being absorbed. It is closed once its lines have moved. */
  sourceSessionId: z.uuid(),
})

export const applyDiscountSchema = z
  .object({
    type: z.enum(['percentage', 'fixed']),
    /** Percent for percentage, major units for fixed. Converted below. */
    value: z.union([z.number(), z.string()]),
    /**
     * Required, and not optional-with-a-default. A discount with no stated
     * reason is exactly the record an owner cannot audit later.
     */
    reason: z.string().trim().min(1, 'Give a reason for this discount').max(200),
  })
  .transform((input, ctx) => {
    if (input.type === 'percentage') {
      const percent = Number(input.value)
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        ctx.addIssue({
          code: 'custom',
          message: 'Enter a percentage between 0 and 100',
          path: ['value'],
        })
        return z.NEVER
      }
      return {
        type: 'percentage' as const,
        value: Math.round(percent * 100),
        reason: input.reason,
      }
    }

    const parsed = priceMinorSchema.safeParse(input.value)
    if (!parsed.success || parsed.data <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter an amount greater than zero',
        path: ['value'],
      })
      return z.NEVER
    }

    return {
      type: 'fixed' as const,
      value: parsed.data,
      reason: input.reason,
    }
  })

export const voidLineSchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason').max(200),
})

export type OpenTakeawayInput = z.infer<typeof openTakeawaySchema>
export type StaffOrderInput = z.infer<typeof staffOrderSchema>
export type TransferSessionInput = z.infer<typeof transferSessionSchema>
export type MergeSessionsInput = z.infer<typeof mergeSessionsSchema>
export type ApplyDiscountInput = z.infer<typeof applyDiscountSchema>
