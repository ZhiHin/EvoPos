import { z } from 'zod'

/**
 * Input contracts for the menu engine.
 *
 * Money arrives from the client as a decimal string or number of major units
 * ("12.50") and is converted to integer minor units here, at the edge. Every
 * layer below this one deals only in integers.
 */

/**
 * Parses a price into integer minor units.
 *
 * Accepts a number or a string so a form can send "12.50" without the client
 * having to know the currency's exponent. The multiply-then-round is the
 * whole point: `12.10 * 100` is 1209.9999999999998 in IEEE 754, and
 * truncating that yields 1209 — a bill one cent light, every time, on a
 * perfectly ordinary price.
 */
export const priceMinorSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'string' ? Number(value.trim()) : value

    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid amount' })
      return z.NEVER
    }
    if (parsed < 0) {
      ctx.addIssue({ code: 'custom', message: 'Amount cannot be negative' })
      return z.NEVER
    }
    // ~21 million major units. Comfortably beyond any real menu price, and
    // low enough that totals cannot overflow a 32-bit integer column.
    if (parsed > 21_000_000) {
      ctx.addIssue({ code: 'custom', message: 'Amount is too large' })
      return z.NEVER
    }

    return Math.round(parsed * 100)
  })

const basisPointsFromPercent = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'string' ? Number(value.trim()) : value
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      ctx.addIssue({ code: 'custom', message: 'Enter a rate between 0 and 100' })
      return z.NEVER
    }
    return Math.round(parsed * 100)
  })

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, 'Category name is required').max(120),
  description: z.string().trim().max(500).optional(),
  parentId: z.uuid().nullable().optional(),
  displayOrder: z.number().int().min(0).max(9999).default(0),
  status: z.enum(['active', 'hidden']).default('active'),
})

export const updateCategorySchema = createCategorySchema.partial()

// ---------------------------------------------------------------------------
// Tags, allergens, dietary labels
// ---------------------------------------------------------------------------

export const createTagSchema = z.object({
  name: z.string().trim().min(1, 'Tag name is required').max(60),
  kind: z.enum(['label', 'allergen', 'dietary']).default('label'),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #ef4444')
    .optional(),
})

export const updateTagSchema = createTagSchema.partial()

// ---------------------------------------------------------------------------
// Custom attribute definitions
// ---------------------------------------------------------------------------

export const attributeTypeSchema = z.enum([
  'text',
  'number',
  'boolean',
  'select',
  'multiselect',
])

export const createAttributeSchema = z
  .object({
    /**
     * Constrained to a snake_case identifier because it becomes a JSONB key
     * queried by name. Allowing arbitrary text would mean keys containing
     * quotes and dots, which are painful to address in SQL and easy to
     * mistype irrecoverably once items carry values under them.
     */
    key: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(
        z
          .string()
          .min(1, 'Key is required')
          .max(40)
          .regex(
            /^[a-z][a-z0-9_]*$/,
            'Start with a letter; use lowercase letters, digits and underscores',
          ),
      ),
    label: z.string().trim().min(1, 'Label is required').max(80),
    type: attributeTypeSchema,
    options: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    required: z.boolean().default(false),
    displayOrder: z.number().int().min(0).max(9999).default(0),
  })
  .refine(
    (v) =>
      !['select', 'multiselect'].includes(v.type) ||
      (v.options?.length ?? 0) > 0,
    {
      message: 'Select fields need at least one option',
      path: ['options'],
    },
  )

// ---------------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------------

const availabilityWindowSchema = z
  .object({
    /** 0 = Sunday, matching JavaScript's getDay(). */
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
  })
  .refine((w) => w.startTime < w.endTime, {
    message: 'End time must be after start time',
    path: ['endTime'],
  })

export const createItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required').max(160),
  description: z.string().trim().max(1000).optional(),
  categoryId: z.uuid().nullable().optional(),

  price: priceMinorSchema,
  costPrice: priceMinorSchema.optional(),

  /** Omit to inherit the restaurant rate; 0 means genuinely zero-rated. */
  taxRatePercent: basisPointsFromPercent.nullable().optional(),
  serviceChargePercent: basisPointsFromPercent.nullable().optional(),

  sku: z.string().trim().max(60).optional(),
  barcode: z.string().trim().max(60).optional(),

  calories: z.number().int().min(0).max(100_000).nullable().optional(),
  prepTimeMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  ingredientsText: z.string().trim().max(2000).optional(),

  status: z.enum(['active', 'hidden', 'archived']).default('active'),
  isFeatured: z.boolean().default(false),
  isRecommended: z.boolean().default(false),
  displayOrder: z.number().int().min(0).max(9999).default(0),

  tagIds: z.array(z.uuid()).max(50).default([]),

  /**
   * Branches where this item is NOT available. Absence means available
   * everywhere, so a single-branch restaurant sends nothing.
   */
  unavailableBranchIds: z.array(z.uuid()).max(200).default([]),

  availability: z.array(availabilityWindowSchema).max(50).default([]),

  /**
   * Values keyed by attribute definition key. Shape is checked here only far
   * enough to be JSON; the real validation happens in the attribute service,
   * which is the only place that knows what this tenant has defined.
   */
  attributes: z.record(z.string(), z.unknown()).default({}),
})

export const updateItemSchema = createItemSchema.partial()

export type CreateCategoryInput = z.infer<typeof createCategorySchema>
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>
export type CreateTagInput = z.infer<typeof createTagSchema>
export type UpdateTagInput = z.infer<typeof updateTagSchema>
export type CreateAttributeInput = z.infer<typeof createAttributeSchema>
export type CreateItemInput = z.infer<typeof createItemSchema>
export type UpdateItemInput = z.infer<typeof updateItemSchema>
