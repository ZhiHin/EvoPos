import { z } from 'zod'

import { priceMinorSchema } from '@/modules/menu/menu.validation'

/**
 * Signed price delta in minor units.
 *
 * Reuses the menu's parser for the magnitude, then re-applies the sign — a
 * modifier delta may legitimately be negative ("small saves 50 cents"), which
 * `priceMinorSchema` alone rejects because a menu price may not be.
 */
export const priceDeltaMinorSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const raw = typeof value === 'string' ? value.trim() : value
    const numeric = Number(raw)

    if (!Number.isFinite(numeric)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid amount' })
      return z.NEVER
    }

    const parsed = priceMinorSchema.safeParse(Math.abs(numeric))
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: 'Amount is out of range' })
      return z.NEVER
    }

    return numeric < 0 ? -parsed.data : parsed.data
  })

const selectionRules = {
  minSelection: z.number().int().min(0).max(50).default(0),
  /** Null or omitted means unlimited. */
  maxSelection: z.number().int().min(1).max(50).nullable().optional(),
}

export const createModifierGroupSchema = z.object({
  name: z.string().trim().min(1, 'Group name is required').max(80),
  description: z.string().trim().max(300).optional(),
  ...selectionRules,
  displayOrder: z.number().int().min(0).max(9999).default(0),
  status: z.enum(['active', 'hidden']).default('active'),
})

export const updateModifierGroupSchema = createModifierGroupSchema.partial()

export const createModifierOptionSchema = z.object({
  name: z.string().trim().min(1, 'Option name is required').max(80),
  priceDelta: priceDeltaMinorSchema.default(0),
  isDefault: z.boolean().default(false),
  maxQuantity: z.number().int().min(1).max(20).default(1),
  displayOrder: z.number().int().min(0).max(9999).default(0),
  isAvailable: z.boolean().default(true),
})

export const updateModifierOptionSchema =
  createModifierOptionSchema.partial()

export const attachModifierGroupSchema = z.object({
  modifierGroupId: z.uuid(),
  minSelectionOverride: z.number().int().min(0).max(50).nullable().optional(),
  maxSelectionOverride: z.number().int().min(1).max(50).nullable().optional(),
  displayOrder: z.number().int().min(0).max(9999).default(0),
})

export const createComboSchema = z.object({
  name: z.string().trim().min(1, 'Combo name is required').max(160),
  description: z.string().trim().max(1000).optional(),
  basePrice: priceMinorSchema,
  status: z.enum(['active', 'hidden', 'archived']).default('active'),
  isFeatured: z.boolean().default(false),
  displayOrder: z.number().int().min(0).max(9999).default(0),
})

export const updateComboSchema = createComboSchema.partial()

export const createComboGroupSchema = z.object({
  name: z.string().trim().min(1, 'Slot name is required').max(80),
  minSelection: z.number().int().min(0).max(50).default(1),
  maxSelection: z.number().int().min(1).max(50).nullable().optional(),
  displayOrder: z.number().int().min(0).max(9999).default(0),
})

export const createComboGroupItemSchema = z.object({
  menuItemId: z.uuid(),
  priceDelta: priceDeltaMinorSchema.default(0),
  isDefault: z.boolean().default(false),
  displayOrder: z.number().int().min(0).max(9999).default(0),
})

export type CreateModifierGroupInput = z.infer<
  typeof createModifierGroupSchema
>
export type UpdateModifierGroupInput = z.infer<
  typeof updateModifierGroupSchema
>
export type CreateModifierOptionInput = z.infer<
  typeof createModifierOptionSchema
>
export type UpdateModifierOptionInput = z.infer<
  typeof updateModifierOptionSchema
>
export type AttachModifierGroupInput = z.infer<
  typeof attachModifierGroupSchema
>
export type CreateComboInput = z.infer<typeof createComboSchema>
export type UpdateComboInput = z.infer<typeof updateComboSchema>
export type CreateComboGroupInput = z.infer<typeof createComboGroupSchema>
export type CreateComboGroupItemInput = z.infer<
  typeof createComboGroupItemSchema
>
