import { z } from 'zod'

/**
 * Branch code appears on receipts and in reports, so it is constrained to
 * something a person can read aloud over a phone: letters and digits only,
 * uppercased for consistency.
 *
 * Uppercased before validation, not after — otherwise "kl01" fails the
 * pattern check before the transform ever runs. Same ordering rule as
 * `emailSchema`, and the same bug if it is reversed.
 */
export const branchCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z
      .string()
      .min(1, 'Branch code is required')
      .max(12, 'Branch code must be at most 12 characters')
      .regex(/^[A-Z0-9]+$/, 'Use letters and digits only'),
  )

export const createBranchSchema = z.object({
  name: z.string().trim().min(1, 'Branch name is required').max(120),
  code: branchCodeSchema,
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  /** IANA zone. Empty means inherit the restaurant's. */
  timezone: z.string().trim().max(64).optional(),
})

export const updateBranchSchema = createBranchSchema.partial()

export type CreateBranchInput = z.infer<typeof createBranchSchema>
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>
