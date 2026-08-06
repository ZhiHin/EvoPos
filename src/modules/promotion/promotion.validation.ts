import { z } from 'zod'

import { priceMinorSchema } from '@/modules/menu/menu.validation'

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')

export const createPromotionSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the promotion a name').max(120),
    description: z.string().trim().max(500).optional(),

    kind: z.enum(['percentage', 'fixed', 'bogo', 'free_item']),
    /** Percent for `percentage`, major units for `fixed`, ignored otherwise. */
    value: z.union([z.number(), z.string()]).optional(),

    priority: z.number().int().min(0).max(9999).default(100),
    isStackable: z.boolean().default(true),
    isActive: z.boolean().default(true),

    validFrom: z.iso.datetime().optional(),
    validTo: z.iso.datetime().optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    startTime: timeSchema.optional(),
    endTime: timeSchema.optional(),
    branchIds: z.array(z.uuid()).max(200).default([]),
    minSpend: priceMinorSchema.optional(),
    categoryIds: z.array(z.uuid()).max(200).default([]),
    menuItemIds: z.array(z.uuid()).max(500).default([]),
    minQuantity: z.number().int().min(0).max(999).default(0),
    requiredTierId: z.uuid().optional(),
    requiresVoucher: z.boolean().default(false),

    maxUsageTotal: z.number().int().min(1).max(1_000_000).optional(),
  })
  .transform((input, ctx) => {
    let value = 0

    if (input.kind === 'percentage') {
      const percent = Number(input.value)
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        ctx.addIssue({
          code: 'custom',
          message: 'Enter a percentage between 0 and 100',
          path: ['value'],
        })
        return z.NEVER
      }
      value = Math.round(percent * 100)
    } else if (input.kind === 'fixed') {
      const parsed = priceMinorSchema.safeParse(input.value)
      if (!parsed.success || parsed.data <= 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'Enter an amount greater than zero',
          path: ['value'],
        })
        return z.NEVER
      }
      value = parsed.data
    }

    /**
     * A window with only one end is almost always a mistake rather than an
     * intent, and silently ignoring the half that was set would make the
     * promotion run at hours nobody chose.
     */
    if ((input.startTime === undefined) !== (input.endTime === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Set both a start and end time, or neither',
        path: ['startTime'],
      })
      return z.NEVER
    }

    return { ...input, value }
  })

export const applyPromotionsSchema = z.object({
  customerId: z.uuid().optional(),
  customerTierId: z.uuid().optional(),
})

export const redeemVoucherSchema = z.object({
  code: z.string().trim().min(1, 'Enter a code').max(40),
})

export const findCustomerSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  phone: z.string().trim().min(3, 'Enter a phone number').max(40),
  email: z.email().optional(),
})

export const adjustPointsSchema = z.object({
  points: z.number().int(),
  reason: z.string().trim().min(1, 'Give a reason').max(200),
})

export type CreatePromotionInput = z.infer<typeof createPromotionSchema>
export type ApplyPromotionsInput = z.infer<typeof applyPromotionsSchema>
export type RedeemVoucherInput = z.infer<typeof redeemVoucherSchema>
export type FindCustomerInput = z.infer<typeof findCustomerSchema>
export type AdjustPointsInput = z.infer<typeof adjustPointsSchema>
