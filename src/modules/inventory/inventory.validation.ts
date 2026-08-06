import { z } from 'zod'

import { priceMinorSchema } from '@/modules/menu/menu.validation'

/**
 * Quantities arrive as human decimals — "1.5" kg, "250" g entered as 0.25 —
 * and are stored as integer milli-units. Parsing here rather than in the UI
 * means the conversion happens once, on the server, where it cannot be
 * skipped by a request that did not come from the form.
 */
export const quantityMilliSchema = z
  .union([z.number(), z.string()])
  .transform((raw, ctx) => {
    const value = typeof raw === 'number' ? raw : Number(raw.trim())

    if (!Number.isFinite(value)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a number' })
      return z.NEVER
    }

    const milli = Math.round(value * 1000)

    if (!Number.isSafeInteger(milli)) {
      ctx.addIssue({ code: 'custom', message: 'That quantity is too large' })
      return z.NEVER
    }

    return milli
  })

export const stockUnitSchema = z.enum(['kg', 'l', 'each'])

export const createIngredientSchema = z.object({
  name: z.string().trim().min(1, 'Give the ingredient a name').max(120),
  category: z.string().trim().max(80).optional(),
  unit: stockUnitSchema,
  costPerUnit: priceMinorSchema.default(0),
  reorderPoint: quantityMilliSchema.default(0),
  reorderQuantity: quantityMilliSchema.default(0),
  preferredSupplierId: z.uuid().optional(),
})

export const setRecipeSchema = z
  .object({
    menuItemId: z.uuid().optional(),
    modifierOptionId: z.uuid().optional(),
    components: z
      .array(
        z.object({
          ingredientId: z.uuid(),
          quantity: quantityMilliSchema,
        }),
      )
      .max(100),
  })
  .refine(
    (input) => Boolean(input.menuItemId) !== Boolean(input.modifierOptionId),
    { message: 'A recipe belongs to a menu item or a modifier option, not both.' },
  )

export const wastageSchema = z.object({
  branchId: z.uuid(),
  ingredientId: z.uuid(),
  quantity: quantityMilliSchema,
  reason: z.string().trim().min(1, 'Say what happened').max(200),
})

export const countSchema = z.object({
  branchId: z.uuid(),
  ingredientId: z.uuid(),
  /** What is physically on the shelf, not the difference. */
  counted: quantityMilliSchema,
  reason: z.string().trim().max(200).optional(),
})

export const transferSchema = z.object({
  fromBranchId: z.uuid(),
  toBranchId: z.uuid(),
  ingredientId: z.uuid(),
  quantity: quantityMilliSchema,
})

export const createSupplierSchema = z.object({
  name: z.string().trim().min(1, 'Give the supplier a name').max(120),
  contactName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  address: z.string().trim().max(300).optional(),
  paymentTermDays: z.number().int().min(0).max(365).default(0),
  notes: z.string().trim().max(1000).optional(),
})

export const createPurchaseOrderSchema = z.object({
  branchId: z.uuid(),
  supplierId: z.uuid(),
  expectedAt: z.iso.datetime().optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        ingredientId: z.uuid(),
        quantity: quantityMilliSchema,
        unitCost: priceMinorSchema,
      }),
    )
    .min(1, 'Add at least one line')
    .max(200),
})

export const receiveGoodsSchema = z.object({
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.uuid(),
        received: quantityMilliSchema,
        unitCost: priceMinorSchema.optional(),
      }),
    )
    .min(1, 'Enter what was received')
    .max(200),
})

export const cancelPurchaseOrderSchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason').max(200),
})
